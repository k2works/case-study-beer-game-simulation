/**
 * 子プロセス（アプリケーション、ブラウザの試験の実行器）に渡す環境を、空から組み立てる（security-design.md）。
 * 親の環境から継承するのは、実行に必要な最小の許可リストだけにする。PG* や DATABASE_URL などの
 * 外部の接続情報、鍵、不明な変数は継承しない。
 */

export class UnsafeEnvError extends Error {
  constructor(name: string) {
    super(`子プロセスの環境に外部の接続情報（${name}）は渡せません`);
    this.name = 'UnsafeEnvError';
  }
}

/** 親の環境から継承してよい変数（実行ファイルの探索とロケールに限る）。 */
const INHERITED = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SYSTEMROOT',
] as const;

const FORBIDDEN_EXPLICIT = /^PG/;

export function buildChildEnv(
  parent: Record<string, string | undefined>,
  extras: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = parent[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  for (const [name, value] of Object.entries(extras)) {
    if (FORBIDDEN_EXPLICIT.test(name)) {
      throw new UnsafeEnvError(name);
    }
    env[name] = value;
  }
  return env;
}
