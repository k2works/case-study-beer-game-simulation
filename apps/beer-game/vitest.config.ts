import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/u1/**/*.test.ts',
      'tests/u2/**/*.test.ts',
      'tests/u3/**/*.test.ts',
      'tests/u4/**/*.test.ts',
      'tests/u5/**/*.test.ts',
      'tests/u5/**/*.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'src/domain/**',
        'src/application/**',
        'src/security/**',
        'src/learning/**',
        'src/retention/**',
        'src/infrastructure/**',
        'src/ui/**',
      ],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
