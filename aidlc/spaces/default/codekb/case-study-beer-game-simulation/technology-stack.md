# Technology Stack

## Languages and Runtimes

| Technology | Version | Purpose | Evidence |
|---|---:|---|---|
| JavaScript ESM | Node.js 22.x | Gulp と運用タスク | `package.json`, `README.md` |
| Markdown | N/A | 要件・設計・運用ドキュメント | `docs/` |
| YAML | N/A | MkDocs、Compose、GitHub Actions | `mkdocs.yml`, `.github/workflows/` |
| Nix | Flake lock で固定 | 再現可能な開発 shell | `flake.nix`, `ops/nix/` |

## JavaScript Dependencies

| Package | Declared version | Purpose |
|---|---:|---|
| `gulp` | `^5.0.0` | タスク runner |
| `dotenv` | `^17.2.3` | `.env` 読込み |
| `marked` | `^18.0.9` | Markdown → HTML |
| `plantuml-encoder` | `^1.4.0` | PlantUML server URL 生成 |

## Tooling and Platforms

- Docker / Docker Compose: 開発 container、MkDocs、SonarQube。
- MkDocs Material: ドキュメントサイト。
- GitHub Actions: docs publish と container publish。
- GitHub Pages / GHCR: 配布先。
- SonarQube: ローカル品質分析の補助。

## Application Stack Status

ビールゲーム本体の frontend framework、backend framework、database、realtime transport、test framework は未選定です。既存 Node.js tooling はアプリ採用を拘束しません。

## Sources

- `package.json`
- `package-lock.json`
- `README.md`
- `flake.nix`
- `Dockerfile`

## Assumptions & Open Questions

- 技術選定では、原子的週確定、役割別認可、再接続、15 チーム同時利用、2 秒以内の反映を満たす必要があります。
