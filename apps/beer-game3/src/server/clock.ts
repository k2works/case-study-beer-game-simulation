import { randomBytes } from 'node:crypto';

/** 時計。試験では固定の値に差し替える。 */
export interface Clock {
  now(): Date;
}

/** 乱数。試験では固定の乱数に差し替える。 */
export interface RandomSource {
  bytes(size: number): Buffer;
}

export const systemClock: Clock = { now: () => new Date() };

export const cryptoRandom: RandomSource = { bytes: (size) => randomBytes(size) };

/** 乱数から UUID（v4 の形）を作る。 */
export function uuidFrom(random: RandomSource): string {
  const bytes = random.bytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
