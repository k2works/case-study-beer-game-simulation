// Cucumber-JS の設定。フィーチャーファイルは、Cucumber-JVM・beer-game-rust と共有する apps/beer-game-features/ を 1 か所から読む（ADR-012）。
// @ui のシナリオだけを実行する（@api は Cucumber-JVM の担当）。Undefined・Pending のステップがあれば失敗する（strict が既定）。
// 実行の前に、バックエンドを専用のポート（既定 3100）で起動しておく。画面は、support/hooks.mjs が Vite で起動する（既定 5273）。
export default {
    paths: ['../../beer-game-features/**/*.feature'],
    import: ['support/**/*.mjs', 'steps/**/*.mjs'],
    tags: '@ui',
    format: ['progress-bar', 'summary'],
};
