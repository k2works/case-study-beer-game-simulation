import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/{unit,integration,contract}/**/*.test.ts'],
    passWithNoTests: true,
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
