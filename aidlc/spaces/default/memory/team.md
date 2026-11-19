# Team-Level Rules

> This team's affirmed practices and corrections. Loaded after `org.md` as
> strict-additive guidance; contradictions with broader policy are rejected.
> Populated by the practices-discovery affirmation gate. Edit at the gate,
> not directly.

## Way of Working

私たちは `develop` を統合 branch として使用し、機能開発を `develop` に統合します。リリース時に `develop` から `main` へ merge します。commit message は既存履歴とプロジェクト規約に従い、日本語の Conventional Commits 形式で記述し、scope 名は `beer-game3` とします。

## Walking Skeleton

私たちは最初の実装として、1 ゲームを作成し、4 役割の入力から 1 週分を確定して状態を表示する thin end-to-end slice を完成させます。この walking skeleton によって、UI、application、ドメイン計算、永続化の接続を、機能を広げる前に確認します。beer-game3 は土台コードなしで 1 から作るため、この slice が最初の動くコードになります。beer-game2 の設計は参考にとどめます。

## Testing Posture

- **Methodology**: bdd
- **Methodology evidence**: 週次計算、週確定の冪等性、役割別認可、復元について、利用者から見える振る舞いを Given/When/Then で先に定義する方針を team が選択した。beer-game2 は受入条件との対応表を検査しており、BDD 運用の実績がある。
- **Ordering**: Given/When/Then の振る舞い例と失敗する自動テストを実装前に定義し、最小実装で通した後に refactor します。
- カバレッジは行 80% を基準（floor）とします。beer-game2 の lines・functions・statements 85、branches 75 のしきい値は引き継ぎません。
- Unit Test と主要境界の Integration Test を CI で実行します。
- 決定論的な週次計算には既知系列の golden test を用意し、冪等な週確定、役割別認可、復元を回帰テストで保護します。

## Guard Policy

<!-- Affirmed by the team. Mode: strict, relaxed, or off. Strict here holds for every intent, whatever one person asks in chat; relaxed or off here applies to every intent whose policy came from its scope, unless project.md or the person sets another; changing this line changes it. A section under the retired Change Control heading, written by an earlier release, is still read. -->

## Deployment

`main` へ merge された application を staging へ自動反映します。この自動反映は、beer-game2 では未達だった点を含め、beer-game3 で実際に動かします。staging の確認を経て、production は手動承認後に deploy します。CI と deploy のワークフローは beer-game3 用に別に新しく作り、AWS 環境も beer-game3 専用に用意します。既存の文書公開は `main` push、container publish は tag または手動実行という現在の経路を維持します。

## Code Style

application の技術スタックに適合する formatter、linter、type-check を導入し、CI で実行します。いずれかが失敗した変更は merge しません。実行環境は Node.js 26、データベースは PostgreSQL 18 とします。Node.js ESM と camelCase を継続し、選定した framework の標準規約と repository の設定ファイルを正本とします。
## Forbidden

<!-- Team-specific forbidden patterns -->

## Mandated

<!-- Team-specific mandates -->

## Corrections

<!-- Self-learning loop appends here. -->
