# Team Practices

## Way of Working

私たちは `develop` を統合 branch として使用し、機能開発を `develop` に統合します。リリース時に `develop` から `main` へ merge します。commit message は既存履歴とプロジェクト規約に従い、日本語の Conventional Commits 形式で記述します。

## Walking Skeleton

私たちは最初の実装として、1 ゲームを作成し、4 役割の入力から 1 週分を確定して状態を表示する thin end-to-end slice を完成させます。この walking skeleton によって、UI、application、ドメイン計算、永続化の接続を、機能を広げる前に確認します。

## Testing Posture

- **Methodology**: bdd
- **Methodology evidence**: 週次計算、週確定の冪等性、役割別認可、復元について、利用者から見える振る舞いを Given/When/Then で先に定義する方針を team が選択しました。
- **Ordering**: Given/When/Then の振る舞い例と失敗する自動テストを実装前に定義し、最小実装で通した後に refactor します。
- classic scope の 80% line coverage floor を満たし、Unit Test と主要境界の Integration Test を CI で実行します。
- 決定論的な週次計算には既知系列の golden test を用意し、冪等な週確定、役割別認可、復元を回帰テストで保護します。

## Deployment

`main` へ merge された application を staging へ自動反映します。staging の確認を経て、production は手動承認後に deploy します。既存の文書公開は `main` push、container publish は tag または手動実行という現在の経路を維持します。

## Code Style

application の技術スタックに適合する formatter、linter、type-check を導入し、CI で実行します。いずれかが失敗した変更は merge しません。既存 JavaScript では Node.js ESM と camelCase を継続し、選定した framework の標準規約と repository の設定ファイルを正本とします。

## Sources

- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/code-structure.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/technology-stack.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/dependencies.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/code-quality-assessment.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/architecture.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/business-overview.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/practices-discovery/practices-discovery-questions.md`
- `.github/workflows/mkdocs.yml`
- `.github/workflows/docker-publish.yml`
- Git history through commit `258e450367415d0593b66b369c0bf432c4dcec3e`

## Assumptions & Open Questions

None.
