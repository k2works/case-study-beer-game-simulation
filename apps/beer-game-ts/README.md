# beer-game-ts

ビールゲームシミュレーション v2 の実装です（`apps/beer-game` は参照用に残しています）。

- 計画: [リリース計画](../../docs/development/beer-game-ts/release_plan.md)、[Bolt 1 計画](../../docs/development/beer-game-ts/bolt_1_plan.md)
- 設計: [設計ドキュメント](../../docs/design/beer-game-ts/index.md)
- 環境構築: [アプリケーション開発環境セットアップ手順書](../../docs/operation/beer-game-ts/application_dev_setup.md)

## コードの案内

初めて読むときは、まず [サイトシーイング・マップ](../../docs/design/beer-game-ts/sightseeing-map.md)（見どころ 7 か所）で全体をつかみ、次に [ガイドツアー: ウォーキングスケルトン](../../docs/design/beer-game-ts/guided-tour-walking-skeleton.md) から。発注の保存から 1 週が確定するまでを、7 ステップでたどれます。地図は JSDoc の `@landmark <説明>`、ツアーは `@guidedTour <ツアー名> <順序> <説明>` から生成します（`npm run docs:tour`。コードとの一致は CI が検査します）。核心は [コアのハイライト](../../docs/design/beer-game-ts/generated/core-highlight.md)、言葉とイベントは [用語集](../../docs/design/beer-game-ts/generated/glossary.md)・[イベント一覧](../../docs/design/beer-game-ts/generated/events.md) にあります（`@core`・`@term` と共用体型から生成。`npm run docs:living`。設計書の表との不一致は CI が検査します）。

## 構成

```text
src/
  domain/        値オブジェクト、simulateWeek、Game / Session 集約（他の層に依存しない）
  ports/         リポジトリ、UnitOfWork、Clock などの契約
  application/   ユースケース（読み込み → 集約の呼び出し → 保存。ルールを持たない）
  adapters/
    http/        Fastify、共有の契約（`/api/v1`）の経路、Problem JSON、資格（HMAC）
    persistence/ PostgreSQL（pg）、LISTEN/NOTIFY
  config/        環境変数の読み込み（本番で鍵が無ければ起動に失敗）
migrations/      node-pg-migrate（SQL）
tests/           unit / contract / integration
```

層の依存は ESLint の `no-restricted-imports` で検査します（`npm run lint`）。

## API と画面

HTTP の API は、Kotlin 版・Rust 版と共有の契約 [`apps/beer-game-contracts/openapi.yaml`](../beer-game-contracts/openapi.yaml)（`/api/v1`）に従います。画面も共有の [`apps/beer-game-web`](../beer-game-web)（React + Vite）で、TS 版には画面のコードを持ちません。契約への適合は `tests/contract`（Ajv で応答のスキーマを検査。未実装の操作は `tests/contract/pending.ts`）が守り、画面の受け入れ（`@ui`。27 シナリオ）は CI の `e2e` ジョブが TS 版のバックエンドで実行します。

画面を TS 版のバックエンドで動かす（開発）:

```sh
npm run db:up && npm run migrate:local
ALLOWED_ORIGINS=http://localhost:5173 COOKIE_SECURE=false npm start   # API（3000）
cd ../beer-game-web && npm ci && npm run dev                          # 画面（5173。/api を 3000 へ転送）
```

## よく使うコマンド

| コマンド                           | 内容                                                                                                       |
| :--------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| `npm run db:up`                    | PostgreSQL 18 を起動（ポート 5433）                                                                        |
| `npm run migrate`                  | マイグレーションを適用（`DATABASE_URL` が必要）                                                            |
| `npm start`                        | API（3000）。画面は `apps/beer-game-web` を別に起動する（上の「API と画面」）                              |
| `npm run dev`                      | DB 起動 → マイグレーション → API（3000）                                                                   |
| `npm run dev:bots -- <参加コード>` | 1 人で遊ぶための開発用ボット（3 体）。`BOT_STRATEGY=reactive` で注文が増幅する発注方式。手順は手順書を参照 |
| `npm run smoke`                    | 起動中の API に、作成から確定までを通して動作を確認                                                        |
| `npm run verify`                   | format、lint、typecheck、カバレッジ付きテスト、受入条件の対応表、ガイドツアーの一致                        |
| `npm run acceptance`               | 受入条件とテストの対応表を出力（未対応があれば失敗）                                                       |
