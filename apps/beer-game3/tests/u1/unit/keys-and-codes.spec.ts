import { describe, expect, it } from 'vitest';
import {
  generateJoinCode,
  generateSecret,
  normalizeJoinCode,
} from '../../../src/server/access/codes.js';
import {
  loadKeyRing,
  seal,
  unseal,
  hmacCandidates,
  hmacForStorage,
} from '../../../src/server/access/keys.js';
import { ConfigError } from '../../../src/server/errors.js';
import { SequenceRandom, TEST_ENV } from '../support/world.js';

describe('鍵の読み込み（NFR6.3、NFR6.11）', () => {
  it('鍵が無ければ起動を拒否する', () => {
    expect(() => loadKeyRing({})).toThrow(ConfigError);
    expect(() => loadKeyRing({ CODE_ENC_KEY: TEST_ENV.CODE_ENC_KEY })).toThrow(ConfigError);
    expect(() => loadKeyRing({ CODE_HMAC_KEY: TEST_ENV.CODE_HMAC_KEY })).toThrow(ConfigError);
  });

  it('形式の違う鍵・短い鍵は拒否する（鍵の値は例外の文面に出さない）', () => {
    const secret = Buffer.alloc(8, 1).toString('base64');
    for (const bad of ['nokeyid', `e1:${secret}`, `bad id:${secret}`, 'e1:!!!']) {
      const attempt = () => loadKeyRing({ ...TEST_ENV, CODE_ENC_KEY: bad });
      expect(attempt).toThrow(ConfigError);
      try {
        attempt();
      } catch (error) {
        expect((error as Error).message).not.toContain(secret);
      }
    }
  });

  it('古い鍵を追加で読める（入れ替えの間）', () => {
    const ring = loadKeyRing({
      ...TEST_ENV,
      CODE_ENC_KEY_PREVIOUS: `e0:${Buffer.alloc(32, 7).toString('base64')}`,
      CODE_HMAC_KEY_PREVIOUS: `h0:${Buffer.alloc(32, 9).toString('base64')}`,
    });
    expect(ring.enc.previous).toHaveLength(1);
    expect(ring.hmac.previous).toHaveLength(1);
  });
});

describe('暗号化と鍵付きハッシュ', () => {
  const ring = loadKeyRing(TEST_ENV);
  const random = new SequenceRandom();

  it('暗号化した値は平文を含まず、毎回違い、復号すると元に戻る（文脈が同じ場合）', () => {
    const a = seal(ring, 'ABCDE23456', 'g1:join', random);
    const b = seal(ring, 'ABCDE23456', 'g1:join', random);
    expect(a).not.toContain('ABCDE23456');
    expect(a).not.toBe(b);
    expect(unseal(ring, a, 'g1:join')).toBe('ABCDE23456');
  });

  it('文脈が違う・改ざんされた値は復号に失敗する（推測で返さない）', () => {
    const sealed = seal(ring, 'ABCDE23456', 'g1:join', random);
    expect(() => unseal(ring, sealed, 'g2:join')).toThrow();
    const parts = sealed.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => unseal(ring, parts.join('.'), 'g1:join')).toThrow();
    expect(() => unseal(ring, 'garbage', 'g1:join')).toThrow();
  });

  it('鍵の入れ替え: 古い鍵で暗号化した値は、古い鍵を残している間は復号でき、外すと復号できない', () => {
    const oldKey = `e0:${Buffer.alloc(32, 7).toString('base64')}`;
    const oldHmac = `h0:${Buffer.alloc(32, 9).toString('base64')}`;
    const oldRing = loadKeyRing({ CODE_ENC_KEY: oldKey, CODE_HMAC_KEY: oldHmac });
    const sealedOld = seal(oldRing, 'ABCDE23456', 'g1:join', random);
    const hashOld = hmacForStorage(oldRing, 'ABCDE23456');
    const rotated = loadKeyRing({
      ...TEST_ENV,
      CODE_ENC_KEY_PREVIOUS: oldKey,
      CODE_HMAC_KEY_PREVIOUS: oldHmac,
    });
    expect(unseal(rotated, sealedOld, 'g1:join')).toBe('ABCDE23456');
    expect(hmacCandidates(rotated, 'ABCDE23456')).toContain(hashOld);
    // 新しい保存は新しい鍵（識別子）で行う
    expect(hmacForStorage(rotated, 'ABCDE23456').startsWith('h1:')).toBe(true);
    expect(seal(rotated, 'X', 'g1:join', random).split('.')[1]).toBe('e1');
    // 旧鍵を外した後は復号できない
    expect(() => unseal(loadKeyRing(TEST_ENV), sealedOld, 'g1:join')).toThrow();
  });

  it('鍵付きハッシュは鍵が違えば値が違い、平文を含まない', () => {
    const other = loadKeyRing({
      CODE_ENC_KEY: TEST_ENV.CODE_ENC_KEY,
      CODE_HMAC_KEY: `h1:${Buffer.alloc(32, 3).toString('base64')}`,
    });
    expect(hmacForStorage(ring, 'ABCDE23456')).not.toBe(hmacForStorage(other, 'ABCDE23456'));
    expect(hmacForStorage(ring, 'ABCDE23456')).not.toContain('ABCDE23456');
  });
});

describe('コードの発行（NFR6.1）', () => {
  it('参加コードは 8 文字以上の英数字で、紛らわしい文字を含まない', () => {
    const random = new SequenceRandom();
    for (let i = 0; i < 50; i += 1) {
      const code = generateJoinCode(random);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8,}$/);
    }
  });

  it('乱数を固定の乱数に差し替えると、同じコードが出る', () => {
    expect(generateJoinCode(new SequenceRandom())).toBe(generateJoinCode(new SequenceRandom()));
  });

  it('秘密のコードは 128 ビット以上で、種類の印が付く', () => {
    const secret = generateSecret(new SequenceRandom(), 'fac_');
    expect(secret.startsWith('fac_')).toBe(true);
    expect(Buffer.from(secret.slice(4), 'base64url').length).toBeGreaterThanOrEqual(16);
  });

  it('入力された参加コードは、大文字・小文字・ハイフン・空白を区別せずに正規化する', () => {
    expect(normalizeJoinCode(' abcd-2345 ')).toBe('ABCD2345');
  });
});
