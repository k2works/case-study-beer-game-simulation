# Dependencies

## External Dependencies

| Dependency | Consumer | Purpose |
|---|---|---|
| Node.js / npm | root tooling | Gulp タスク実行と package 管理 |
| Docker / Docker Compose | MkDocs / SonarQube / dev container | container 実行 |
| Nix | development environments | 再現可能な shell |
| Git | journal / release tasks | 履歴取得と release 操作 |
| Python / MkDocs | documentation | docs build / serve |
| GitHub Actions, Pages, GHCR | CI workflows | publish |
| PlantUML server | manual builder | diagram rendering URL |
| SonarQube | quality utility | static analysis |

## Internal Dependency Graph

- `gulpfile.js` → `ops/scripts/mkdocs.js`
- `gulpfile.js` → `ops/scripts/manual.js`
- `gulpfile.js` → `ops/scripts/journal.js`
- `gulpfile.js` → `ops/scripts/vault.js`
- `gulpfile.js` → `ops/scripts/ssh.js`
- `gulpfile.js` → `ops/scripts/sonar_local.js`
- `gulpfile.js` → `ops/scripts/okf.js`
- `ops/scripts/{mkdocs,sonar_local}.js` → `ops/scripts/shared.js`
- `docs/requirements/beer-game/requirements_definition.md` → JSD 公開資料（根拠資料）
- `apps/beer-game/` → 実装依存関係なし

## Dependency Risks

- package version は caret range であり、lockfile によって実インストールを固定しています。
- PlantUML server への外部接続はマニュアル build の可用性と privacy に影響し得ます。
- 運用スクリプトは Docker、Git、Python 等の PATH 上の外部 CLI を前提とします。
- アプリ本体の runtime dependencies は未定です。

## Sources

- `package.json`
- `package-lock.json`
- `gulpfile.js`
- `ops/scripts/`

## Assumptions & Open Questions

- ビールゲーム実装時に、既存ルート package へ同居させるか独立 workspace にするか決める必要があります。
