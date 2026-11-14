// Cucumber-JS の設定。フィーチャーファイルは、Cucumber-JVM と共有する features/ を 1 か所から読む（ADR-012）。
// @ui のシナリオだけを実行する（@api は Cucumber-JVM の担当）。Undefined・Pending のステップがあれば失敗する（strict が既定）。
export default {
  paths: ['../features/**/*.feature'],
  import: ['steps/**/*.mjs'],
  tags: '@ui',
  format: ['progress-bar', 'summary'],
};
