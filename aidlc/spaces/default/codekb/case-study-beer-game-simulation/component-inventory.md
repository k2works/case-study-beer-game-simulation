# Component Inventory

## Documentation Workspace

- **Responsibility**: 要件、設計、開発、運用、レビュー、参照資料を Markdown で管理する。
- **Dependencies**: MkDocs Configuration、Documentation Automation。
- **Status**: 稼働中。ビールゲーム固有では要件定義のみ実質的内容あり。

## Documentation Automation

- **Responsibility**: Gulp を入口に MkDocs 起動、マニュアル変換、journal 生成を行う。
- **Dependencies**: Node.js Runtime、Container and Nix Environment。
- **Status**: 稼働中。

## Security and Operations Utilities

- **Responsibility**: Vault 暗号化、SSH 操作、SonarQube、OKF の補助タスクを提供する。
- **Dependencies**: Node.js Runtime、外部 CLI、環境変数。
- **Status**: 稼働中だがビールゲーム本体からは独立。

## CI Workflows

- **Responsibility**: MkDocs 公開と Docker image publish を自動化する。
- **Dependencies**: GitHub Actions、Docker、GitHub Pages / GHCR。
- **Status**: 定義済み。

## Beer Game Requirements

- **Responsibility**: ビールゲームの価値、外部環境、システム境界、内部構造、FR/NFR/BR を定義する。
- **Dependencies**: JSD 改訂版ビールゲームキットの参照資料。
- **Status**: draft。

## Beer Game Application

- **Responsibility**: 複数人ゲーム、週次計算、情報制約、復元、分析を実現する予定領域。
- **Dependencies**: Beer Game Requirements。
- **Status**: 未実装（`apps/beer-game/` は `.gitkeep` のみ）。

## Node.js Runtime

- **Responsibility**: Gulp と運用スクリプトの実行。
- **Dependencies**: npm dependencies。
- **Status**: Node.js 22.x を前提。

## Container and Nix Environment

- **Responsibility**: ドキュメント、品質ツール、多言語開発環境を再現可能にする。
- **Dependencies**: Docker / Docker Compose / Nix。
- **Status**: 定義済み。

## Sources

- `package.json`
- `gulpfile.js`
- `ops/`
- `.github/workflows/`
- `docs/requirements/beer-game/requirements_definition.md`
- `apps/beer-game/`

## Assumptions & Open Questions

- Beer Game Application は後続工程で複数コンポーネントへ分割される可能性があります。
