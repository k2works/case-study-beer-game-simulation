import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import type { RandomSource } from '../clock.js';
import { ConfigError } from '../errors.js';

/**
 * 鍵の管理（NFR6.3、NFR6.11）。
 * - 暗号化の鍵（AES-256-GCM）と、照合の鍵（HMAC-SHA-256）は別の鍵。どちらも環境変数から渡す。
 * - 形式は `<鍵の識別子>:<base64>`。識別子は、保存した値に付き、入れ替えの間の鍵の選択に使う。
 * - 鍵が無い・不正なら起動しない。例外の文面に鍵の値を出さない。
 */

export interface Key {
  id: string;
  key: Buffer;
}

export interface KeySet {
  current: Key;
  /** 入れ替えの間だけ残す古い鍵。復号と照合に使い、新規の保存には使わない */
  previous: Key[];
}

export interface KeyRing {
  enc: KeySet;
  hmac: KeySet;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,16}$/;

function parseKey(raw: string, name: string, exactBytes: number | null): Key {
  const separator = raw.indexOf(':');
  const id = separator > 0 ? raw.slice(0, separator) : '';
  const encoded = separator > 0 ? raw.slice(separator + 1) : '';
  if (!KEY_ID.test(id)) {
    throw new ConfigError(
      `${name} の形式が正しくありません（<鍵の識別子>:<base64> の形式で渡してください）`,
    );
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new ConfigError(`${name} の鍵の部分が base64 ではありません`);
  }
  const key = Buffer.from(encoded, 'base64');
  const valid = exactBytes === null ? key.length >= 32 : key.length === exactBytes;
  if (!valid) {
    throw new ConfigError(`${name} の鍵の長さが足りません（32 バイトが必要です）`);
  }
  return { id, key };
}

function parseKeySet(
  env: Record<string, string | undefined>,
  name: string,
  exactBytes: number | null,
): KeySet {
  const current = env[name]?.trim();
  if (!current) {
    throw new ConfigError(`${name} が設定されていません。鍵が無いため起動しません`);
  }
  const previousRaw = env[`${name}_PREVIOUS`]?.trim();
  const previous = previousRaw
    ? previousRaw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map((item) => parseKey(item, `${name}_PREVIOUS`, exactBytes))
    : [];
  return { current: parseKey(current, name, exactBytes), previous };
}

/** 環境変数から鍵を読む。無い・不正なら ConfigError（起動を拒否する）。 */
export function loadKeyRing(env: Record<string, string | undefined>): KeyRing {
  return {
    enc: parseKeySet(env, 'CODE_ENC_KEY', 32),
    hmac: parseKeySet(env, 'CODE_HMAC_KEY', null),
  };
}

/** 照合用の値（保存用）。`<鍵の識別子>:<hex>`。新しい鍵だけで作る。 */
export function hmacForStorage(ring: KeyRing, normalizedCode: string): string {
  const { id, key } = ring.hmac.current;
  return `${id}:${createHmac('sha256', key).update(normalizedCode).digest('hex')}`;
}

/** 照合の候補（新しい鍵と、入れ替えの間の古い鍵のすべて）。 */
export function hmacCandidates(ring: KeyRing, normalizedCode: string): string[] {
  return [ring.hmac.current, ...ring.hmac.previous].map(
    ({ id, key }) => `${id}:${createHmac('sha256', key).update(normalizedCode).digest('hex')}`,
  );
}

/** 値を鍵付きで要約する（接続元のログ用。生の値を残さない）。 */
export function keyedDigest(ring: KeyRing, value: string): string {
  return createHmac('sha256', ring.hmac.current.key)
    .update(`src:${value}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * AES-256-GCM で暗号化する。`v1.<鍵の識別子>.<iv>.<tag>.<暗号文>`（各 base64url）。
 * aad（追加の認証データ）に「ゲームの識別子:コードの種類」を入れ、別の行へ貼り替えた値を復号できなくする。
 */
export function seal(ring: KeyRing, plain: string, aad: string, random: RandomSource): string {
  const { id, key } = ring.enc.current;
  const iv = random.bytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    id,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** 復号する。失敗したら例外を投げる（コードを推測で返さない）。 */
export function unseal(ring: KeyRing, sealed: string, aad: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') {
    throw new Error('暗号化した値の形式が正しくありません');
  }
  const [, id, iv, tag, ciphertext] = parts as [string, string, string, string, string];
  const key = [ring.enc.current, ...ring.enc.previous].find((candidate) => candidate.id === id);
  if (!key) {
    throw new Error('復号に使う鍵が見つかりません');
  }
  const decipher = createDecipheriv('aes-256-gcm', key.key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
