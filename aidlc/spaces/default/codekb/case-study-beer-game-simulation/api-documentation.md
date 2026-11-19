# API Documentation

## beer-game2 の REST API（Fastify 5）

`apps/beer-game2/src/adapters/http/server.ts` のルート定義から確認した範囲です。リクエスト・レスポンスの詳細な形、認可の細部、レート制限の設定は本スキャンでは読んでいません。エラーは Problem JSON。

| メソッド | パス | 用途 |
| :--- | :--- | :--- |
| GET | `/health` | 生存確認（`/ready` は DB 接続を確認。コンテナ検査の記述より） |
| POST | `/api/games` | ゲーム作成 |
| POST | `/api/join` | 参加コードで参加 |
| POST | `/api/recover` | 同じ役割へ復帰 |
| POST | `/api/observe` | 観察者として入室 |
| POST / DELETE | `/api/games/:id/observer-invitations` | 観察者の招待の発行・取消 |
| GET | `/api/games/:id/observation` | 観察ビュー |
| POST | `/api/games/:id/credentials/reissue` | 資格の再発行 |
| GET | `/api/games/:id/lobby` | ロビー |
| POST / DELETE | `/api/games/:id/assignments` | 役割の割当て・解除 |
| POST | `/api/games/:id/start` | 開始 |
| GET | `/api/games/:id/me` | 自分の役割の状況 |
| GET | `/api/games/:id/review` | 振り返り |
| GET | `/api/games/:id/export` | 結果の出力 |
| GET | `/api/games/:id/console` | 進行役のコンソール |
| PUT | `/api/games/:id/decision` | 決定の入力 |
| POST | `/api/games/:id/{action}` | 一時停止・再開・終了系（パス名はコードで生成） |
| PUT | `/api/games/:id/commit-mode` | 確定方式（自動確定） |
| PUT | `/api/games/:id/proxy-decision` | 代理入力 |
| POST | `/api/games/:id/commit` | 週の確定 |
| GET | `/api/games/:id/stream` | SSE（バージョン通知のみ） |

静的ファイルを返すルートも定義されている（`server.get(path…)`）が、対象パスは未確認。

## beer-game（v1）

`apps/beer-game/src/api/app.ts`（562 行）。変更系は `Idempotency-Key` と同一 Origin を要求し、版つき更新は `If-Match`、Cookie は HttpOnly・Secure・SameSite=Strict（`apps/beer-game/README.md`）。個別のルートは未読。

## 内部の契約

`apps/beer-game2/src/ports/index.ts`（214 行）がリポジトリ、UnitOfWork、Clock などを定義する。中身は未読。

## ルートの Gulp タスク

`mkdocs:*`、`manual:*`、`journal:generate`、`vault:*`、`ssh:*`、sonar 系、`okf:*`（`gulpfile.js` と `package.json`）。
