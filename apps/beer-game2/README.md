# beer-game2

ビールゲームシミュレーション v2 の実装です（`apps/beer-game` は参照用に残しています）。

- 計画: [リリース計画](../../docs/development/beer-game2/release_plan.md)、[Bolt 1 計画](../../docs/development/beer-game2/bolt_1_plan.md)
- 設計: [設計ドキュメント](../../docs/design/beer-game2/index.md)
- 環境構築: [アプリケーション開発環境セットアップ手順書](../../docs/operation/beer-game2/application_dev_setup.md)

## コードの案内

初めて読むときは、[ガイドツアー: ウォーキングスケルトン](../../docs/design/beer-game2/guided-tour-walking-skeleton.md) から。発注の保存から 1 週が確定するまでを、7 ステップでたどれます。ツアーは、コードの JSDoc `@guidedTour <ツアー名> <順序> <説明>` から生成します（`npm run docs:tour`。コードとの一致は CI が検査します）。

## 構成

```text
src/
  domain/        値オブジェクト、simulateWeek、Game / Session 集約（他の層に依存しない）
  ports/         リポジトリ、UnitOfWork、Clock などの契約
  application/   ユースケース（読み込み → 集約の呼び出し → 保存。ルールを持たない）
  adapters/
    http/        Fastify、Problem JSON、資格（HMAC）
    persistence/ PostgreSQL（pg）、LISTEN/NOTIFY
  config/        環境変数の読み込み（本番で鍵が無ければ起動に失敗）
ui/              Vite + React + react-router
migrations/      node-pg-migrate（SQL）
tests/           unit / component / integration / e2e
```

層の依存は ESLint の `no-restricted-imports` で検査します（`npm run lint`）。

## よく使うコマンド

| コマンド                           | 内容                                                                                                       |
| :--------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| `npm run db:up`                    | PostgreSQL 18 を起動（ポート 5433）                                                                        |
| `npm run migrate`                  | マイグレーションを適用（`DATABASE_URL` が必要）                                                            |
| `npm start` / `npm run dev:client` | API（3000）/ UI（5173）                                                                                    |
| `npm run dev`                      | DB 起動 → マイグレーション → API（3000）と UI（5173）を同時に起動                                          |
| `npm run dev:bots -- <参加コード>` | 1 人で遊ぶための開発用ボット（3 体）。`BOT_STRATEGY=reactive` で注文が増幅する発注方式。手順は手順書を参照 |
| `npm run smoke`                    | 起動中の API に、作成から確定までを通して動作を確認                                                        |
| `npm run verify`                   | format、lint、typecheck、カバレッジ付きテスト、受入条件の対応表、E2E                                       |
| `npm run acceptance`               | 受入条件とテストの対応表を出力（未対応があれば失敗）                                                       |
