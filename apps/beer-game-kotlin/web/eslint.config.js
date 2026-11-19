import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// 最小の設定。ESLint の推奨と typescript-eslint の推奨だけを使う。
export default tseslint.config(
    {
        ignores: [
            'dist',
            'node_modules',
            'steps',
            'support',
            'cucumber.mjs',
            'scripts',
            'src/api/generated',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
);
