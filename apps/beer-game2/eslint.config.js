import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// 層の依存: domain → (なし) / ports → domain / application → domain, ports / adapters → 内側すべて
const forbid = (...names) => ({
  patterns: names.map((n) => ({
    group: [`**/${n}`, `**/${n}/**`],
    message: `この層から ${n} への依存は禁止です（ADR-003）。`,
  })),
});

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        forbid('ports', 'application', 'adapters', 'config'),
      ],
    },
  },
  {
    files: ['src/ports/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        forbid('application', 'adapters', 'config'),
      ],
    },
  },
  {
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', forbid('adapters', 'config')],
    },
  },
  {
    // 合成監視のスクリプト: CloudWatch Synthetics の Node.js の実行環境が読む CommonJS
    files: ['infra/**/canary/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        exports: 'writable',
        process: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
