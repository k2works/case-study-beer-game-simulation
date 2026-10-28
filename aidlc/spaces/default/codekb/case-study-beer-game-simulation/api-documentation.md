# API Documentation

## Existing Application APIs

ビールゲーム本体の HTTP、WebSocket、GraphQL、RPC、CLI API は存在しません。`apps/beer-game/` は空です。

## Existing Task Interface

ルート `package.json` と `gulpfile.js` は開発者向けタスクインターフェースを提供します。

| Command family | Purpose |
|---|---|
| `npm start` / `gulp spec` | MkDocs を起動してブラウザを開く |
| `npm run docs:*` / `gulp mkdocs:*` | MkDocs の起動・停止・build |
| `npm run manual:build` | Markdown マニュアルを HTML 化 |
| `npm run journal` | Git 履歴から journal を生成 |
| `npm run vault:*` | AES-256-GCM の Vault 操作 |
| `gulp sonar-local:*` | ローカル SonarQube の管理・scan |
| `npm run okf:*` / `gulp okf:*` | Open Knowledge Format の検査・可視化 |
| `gulp ssh:*` | 環境変数で指定した SSH 接続操作 |

## Required Future API Surface

要件はゲーム作成・参加、役割割当て、開始、意思決定、週確定、停止・再開・終了、結果取得・出力を要求します。ただし transport、URL、payload、認証方式は未決定であり、ここでは実装済み API として扱いません。

## Authorization Boundaries

将来 API は進行役、参加者の割当て役割、観察者を識別し、プレイ中の他役割の在庫・受注残・意思決定値と将来需要を返さない必要があります。代理入力は操作者、対象役割、時刻、値を監査記録に残す必要があります。

## Sources

- `package.json`
- `gulpfile.js`
- `docs/requirements/beer-game/requirements_definition.md`

## Assumptions & Open Questions

- REST とリアルタイム通信の境界、認証資格情報、エラー形式、API versioning は未決定です。
