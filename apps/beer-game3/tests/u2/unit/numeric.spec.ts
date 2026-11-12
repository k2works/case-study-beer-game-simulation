import { describe, expect, it } from 'vitest';
import { toSafeInteger, toSafeIntegerOrNull } from '../../../src/server/session/numeric.js';

describe('BR8.2 64 ビット整数（pg は文字列で返す）の安全な変換', () => {
  it('文字列の 64 ビット整数を、安全な範囲なら数値にする', () => {
    expect(toSafeInteger('0')).toBe(0);
    expect(toSafeInteger('132486750000')).toBe(132_486_750_000);
    expect(toSafeInteger(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('数値はそのまま通す', () => {
    expect(toSafeInteger(12)).toBe(12);
  });

  it('安全な整数の範囲を超える値は、丸めずに失敗にする', () => {
    expect(() => toSafeInteger('9007199254740992')).toThrow(/安全な整数/);
    expect(() => toSafeInteger('-9007199254740992')).toThrow(/安全な整数/);
  });

  it('整数でない値は失敗にする', () => {
    expect(() => toSafeInteger('1.5')).toThrow();
    expect(() => toSafeInteger('abc')).toThrow();
    expect(() => toSafeInteger(null)).toThrow();
    expect(() => toSafeInteger(undefined)).toThrow();
  });

  it('null は null のまま（未確定の費用）', () => {
    expect(toSafeIntegerOrNull(null)).toBeNull();
    expect(toSafeIntegerOrNull(undefined)).toBeNull();
    expect(toSafeIntegerOrNull('7')).toBe(7);
  });
});
