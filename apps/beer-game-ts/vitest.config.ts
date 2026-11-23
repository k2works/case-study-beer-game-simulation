import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/{unit,component,integration}/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
    setupFiles: ['tests/support/setup.ts'],
    // 統合テストは同じテスト DB を使うため、ファイルを直列に実行する
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: [
        'src/domain/**',
        'src/application/**',
        'src/adapters/http/**',
        'src/adapters/persistence/**',
      ],
      thresholds: { lines: 85, functions: 85, statements: 85, branches: 75 },
    },
  },
});
