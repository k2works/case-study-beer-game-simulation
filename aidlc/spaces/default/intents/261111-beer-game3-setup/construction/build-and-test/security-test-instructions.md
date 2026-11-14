# セキュリティ試験の手順 - beer-game3

## 自動の試験

| 観点 | 内容 | 試験 |
| :--- | :--- | :--- |
| 認可 | 資格情報の種類（なし、無効、参加者、進行役、観察者、別のゲーム）× すべての経路で、固定の 403 または期待の応答。新しい経路は表に足すまで失敗する | `tests/u4/features/authorization-matrix.spec.ts` |
| 情報の分離 | 他の役割のデータが応答に含まれない（観察者の投影は固定の項目、需要は小売店のみ） | `tests/u1/features/decisions-and-views.spec.ts`、`tests/u4/features/observer.spec.ts`、`tests/u4/features/retailer-demand.spec.ts` |
| 総当たりの制限 | 無効な参加コード 11 回目で 429。有効なコードは数えない。窓の行は上限あり | `tests/u4/features/join-window.spec.ts` |
| 資格情報の保管 | ハッシュのみ保存、暗号化、ログに出さない | `tests/u1/unit`、`tests/u3`、`tests/u4/unit` |
| 入力の検証 | zod、表示名の先頭の `= + - @`、タブ、復帰の拒否、パラメーター化した SQL | `tests/u1`、`tests/u5/unit` |
| ヘッダ | CSP、HSTS（本番）、`Cache-Control: no-store`、出力の `Content-Disposition` | `tests/u1/integration`、`tests/u5` |
| 試験自体の安全 | 接続先が `localhost` 以外なら拒否、`host=` と `PG*` の上書き、秘匿の型、成果物の無効化 | `tests/u6/features/safety.spec.ts` |
| CI の権限 | `contents: read` のみ、シークレットなし、デプロイなし、actions は完全なコミットの識別子で固定 | `tests/u6/unit/ci-workflow.spec.ts` |
| 依存 | 検証の依存が `devDependencies` にのみ、版を固定。本番の依存に含まれない | `tests/u6/unit/ci-changes-and-deps.spec.ts`、`npm --prefix apps/beer-game3 run verify:prod-deps` |

## 手動・別工程の確認

| 項目 | 内容 | 担当 |
| :--- | :--- | :--- |
| `npm audit` | 新しい依存に既知の脆弱性がないこと。既存の依存の中等度 11 件（eslint など、開発用）は U6 以前から | 実行して記録 |
| HTTPS、HSTS、プロキシの段数 | 稼働環境の設定 | environment-provisioning、deployment-pipeline |
| SAST / DAST | 稼働環境に対する走査 | Operation |

## 既知の未解決（U6 のレビューの指摘）

- 接続先の検査が、ホストのない接続文字列と実行環境の `PGHOST` の組み合わせで外部へ向き得る（Major）。
- Playwright の実行器が親の環境（`DATABASE_URL`、`PG*`）を引き継ぐ（Minor）。
