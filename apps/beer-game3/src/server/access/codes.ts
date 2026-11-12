import { createHash } from 'node:crypto';
import type { RandomSource } from '../clock.js';

/** 参加コードの文字。紛らわしい文字（0 と O、1 と I）を除いた 32 種類の英数字（256 を割り切るので偏りがない）。 */
const JOIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_LENGTH = 10;

/** 秘密のコードと token のバイト数。128 ビット以上（NFR6.1）。 */
export const SECRET_BYTES = 24;

export const PREFIX_FACILITATOR = 'fac_';
export const PREFIX_OBSERVER = 'obs_';
export const PREFIX_TOKEN = 'tok_';

export function generateJoinCode(random: RandomSource): string {
  const bytes = random.bytes(JOIN_CODE_LENGTH);
  let code = '';
  for (const byte of bytes) {
    code += JOIN_ALPHABET[byte % JOIN_ALPHABET.length];
  }
  return code;
}

/** 種類の印（prefix）付きの、128 ビット以上の秘密のコード。印は資格情報の種類の判定に使う。 */
export function generateSecret(random: RandomSource, prefix: string): string {
  return `${prefix}${random.bytes(SECRET_BYTES).toString('base64url')}`;
}

/** 入力された参加コードを、大文字・ハイフンなし・空白なしにそろえる。 */
export function normalizeJoinCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

/** 鍵なしの SHA-256（128 ビット以上の乱数だけに使う。総当りできない）。 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
