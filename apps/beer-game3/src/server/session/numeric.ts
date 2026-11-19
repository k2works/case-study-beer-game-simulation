/**
 * 保存先の数値の変換（BR8.2）。
 * pg は 64 ビット整数（int8）を文字列で返す。費用は、安全な整数（2 の 53 乗未満）の範囲で数値にする。
 * 範囲を超える値は丸めずに失敗にする（誤った費用を静かに表示・出力しないため）。
 */
export function toSafeInteger(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`安全な整数の範囲に収まらない値です: ${String(value)}`);
    }
    return value;
  }
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new Error(`整数として読めない値です: ${String(value)}`);
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`安全な整数の範囲に収まらない値です: ${value}`);
  }
  return Number(parsed);
}

export function toSafeIntegerOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : toSafeInteger(value);
}
