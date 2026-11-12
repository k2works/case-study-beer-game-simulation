import { defineConfig } from 'vitest/config';

// 試験用の固定の鍵（本番の鍵と共有しない）。形式は `<鍵の識別子>:<base64 の 32 バイト>`。
const TEST_ENC_KEY = 'e1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const TEST_HMAC_KEY = 'h1:ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['tests/u1/web/setup.ts'],
    // 結合の試験が同じ PostgreSQL を使うため、ファイルは順に実行する。
    fileParallelism: false,
    env: {
      CODE_ENC_KEY: process.env.CODE_ENC_KEY ?? TEST_ENC_KEY,
      CODE_HMAC_KEY: process.env.CODE_HMAC_KEY ?? TEST_HMAC_KEY,
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // 起動の入口（プロセスの起動と画面の描画先の指定だけ）は試験の対象にせず、
      // 起動の動作は検証コマンドの手元実行（スモーク）で確かめる。
      exclude: ['src/server/main.ts', 'src/web/main.tsx', 'src/**/*.d.ts'],
      reporter: ['text', 'text-summary', 'json-summary'],
      thresholds: {
        lines: 80,
      },
    },
  },
});
