# Code Structure

## Repository Layout

| Path | Classification | Responsibility |
|---|---|---|
| `apps/beer-game/` | Application placeholder | ビールゲーム本体の予定領域。現在は空 |
| `docs/requirements/beer-game/` | Specification | ビールゲームの RDRA 2.0 要件 |
| `docs/{design,development,adr,operation,review}/beer-game/` | Documentation placeholders | 後続成果物の索引 |
| `gulpfile.js` | Configuration / task entry | Gulp タスクモジュールの登録 |
| `ops/scripts/` | Utility / operations | ドキュメント、Vault、SSH、SonarQube、OKF 等のタスク |
| `ops/docker/` | Infrastructure | MkDocs と SonarQube のコンテナ定義 |
| `ops/nix/` | Development environment | 言語別 Nix shell |
| `.github/workflows/` | CI/CD | ドキュメントとコンテナの GitHub Actions |

## Module Patterns

`gulpfile.js` は各 `ops/scripts/*.js` の default export に Gulp インスタンスを渡します。各モジュールは関連タスクを登録する機能単位構成です。`shared.js` は Docker 環境の整理、利用可否判定、URL オープンを提供します。

## Application Source Status

ビールゲーム向けの Model、Controller、Service、Repository、UI Component、Migration、Test は存在しません。したがって、既存のアプリケーション規約、import graph、循環依存、公開 API はまだありません。

## File Classification

- Configuration: `package.json`、`mkdocs.yml`、`docker-compose.yml`、`flake.nix`、`.devcontainer/devcontainer.json`
- Utilities: `ops/scripts/*.js`
- CI/CD: `.github/workflows/*.yml`
- Specifications: `docs/requirements/beer-game/requirements_definition.md`
- Static assets: `docs/assets/`
- Tests / migrations: なし

## Sources

- `package.json`
- `gulpfile.js`
- `ops/scripts/`
- `apps/beer-game/`

## Assumptions & Open Questions

- 後続設計でアプリのパッケージ境界とテスト配置を決める必要があります。
