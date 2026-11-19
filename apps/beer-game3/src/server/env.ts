import { ConfigError } from './errors.js';

/**
 * 環境変数の整数を、範囲つきで読む。未指定と空白だけの値は既定にする。
 * 整数でない値や範囲の外は ConfigError で、起動を拒否する（設定の誤りは起動時に分かる）。
 */
export function parseInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} は ${min} 以上 ${max} 以下の整数で指定してください`);
  }
  return value;
}
