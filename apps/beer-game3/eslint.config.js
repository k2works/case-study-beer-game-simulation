import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', 'test-results', 'playwright-report'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    // BR19.2: 入口（HTTP）は GameSession を直接 import できない。外へ出る経路は access/session-gateway だけ
    // NFR6.5: Reporting と Retention も直接 import できない（Reporting は権限の判定のあとに gateway が呼び、
    // Retention は起動を組み立てる main.ts だけが組み合わせる）
    files: ['src/server/http/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/game-session', '**/game-session.js'],
              message:
                '入口から GameSession を直接 import しないでください。access/session-gateway を経由します（BR19.2）',
            },
            {
              group: ['**/reporting/**', '**/retention/**'],
              message:
                '入口から Reporting や Retention を直接 import しないでください。Reporting は access/session-gateway を経由し、Retention は main.ts だけが組み合わせます（NFR6.5）',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    // 画面の試験（NFR2.3）: 固定の待ちを禁止する。表示の状態を待つ（expect、expect.poll、waitForFunction）。
    // 時刻に依存する振る舞いは page.clock で進める。固定の setTimeout による待ちも使わない
    files: ['verification/e2e/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'waitForTimeout',
          message:
            'page.waitForTimeout は使えません。表示の状態を待ってください（expect、expect.poll、waitForFunction）。時刻は page.clock で進めます',
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'setTimeout',
          message:
            '固定の setTimeout による待ちは使えません。表示の状態を待ってください（expect、expect.poll、waitForFunction）',
        },
      ],
    },
  },
);
