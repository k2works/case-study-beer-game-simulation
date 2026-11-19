# コード生成の要約 - U1 u1-walking-skeleton

**Developer:** aidlc-developer-agent

## Summary

- Built: 薄い一通り（ゲームの作成 → 4 人の参加 → 役割の割当て → 開始 → 4 役割の入力 → 週の確定 → 役割別の状態の表示）。最初の動くコード。`apps/beer-game3/` に新しく作った（beer-game2 のコードは複製していない。他のアプリと docs は触っていない）。
- Tests: 206 件がすべて成功（振る舞い 108、単体 30、結合 21、画面 47）。行カバレッジ 94.05%（閾値 80%、下げていない）。型検査・lint・書式は無エラー。
- 方法は BDD。各スライドで、振る舞いの例（Given/When/Then）と失敗する試験を先に書き、失敗を確かめてから最小の実装で通した（記録は「失敗の確認」）。

## 作ったもの（`apps/beer-game3/`）

| 場所 | 内容 |
| :--- | :--- |
| `src/server/domain/engine.ts`、`types.ts` | SimulationEngine（C2）。副作用のない週の計算、枠の前進、整数の費用。役割・上限などの定数 |
| `src/server/access/` | AccessControl（C4）: コード・token の発行、HMAC-SHA-256 と SHA-256 による照合、AES-256-GCM での暗号化、鍵の読み込み、権限の判定 |
| `src/server/session/game-session.ts` | GameSession（C3）: 作成、参加、割当て、開始、入力、週の確定、状態の取得、コードの再表示 |
| `src/server/session/projection.ts`、`week-state.ts`、`schemas.ts` | 役割別の投影、週の初めの状態の組み立て、zod による入力の検証 |
| `src/server/session/store.ts`、`pg-store.ts`、`memory-store.ts` | 保存の境界。PostgreSQL（行の占有・lock_timeout・1 トランザクション）とメモリ（同じ約束の試験用） |
| `src/server/http/app.ts` | Fastify の入口（C1）: 共通の `Problem`、要求の識別子、構造化ログ、セキュリティヘッダ、HTTPS の強制、`/health`、画面の配信 |
| `src/server/config.ts`、`main.ts`、`migrate.ts`、`scripts/migrate.mjs` | 環境変数の読み込み（鍵が無ければ起動しない）、起動、移行の実行 |
| `migrations/1762900000000_u1-schema.sql` | `games`、`game_settings`、`demand_series`、`participants`、`role_assignments`、`week_records`、`pipeline_slots`、`access_codes`、`return_tokens`、`idempotency_records`（entities.md が正本） |
| `src/web/` | React の画面 S0 参加入口、S1 ゲーム作成、S2 ロビー、S3 役割別プレイ、進行役の最小の進行管理（確定）。1 秒おきの取り直し、日本語のみ、`data-testid` 付き |
| `tests/u1/` | `features/`（振る舞い）、`unit/`、`integration/`（実際の PostgreSQL）、`web/`（画面）、`support/` |
| 設定 | `package.json`（版を固定）、`tsconfig*.json`、`eslint.config.js`、`.prettierrc.json`、`vitest.config.ts`、`vite.config.ts`、`.nvmrc`、`.env.example`、`README.md` |

## 主な決定

- **週の計算**: 4 役割とも週の初めの状態だけを入力にするので、計算の順序によらず同じ結果になる。枠は `[remainingWeeks 1（当週に届く）, remainingWeeks 2（次の週に届く）]`。第 t 週の出荷・発注・生産要請は第 t+2 週に届く。前週末の在庫・受注残・累積費用は、前の週の確定済みの記録から求め、第 1 週は設定から求める（保存するのは枠と週の記録だけ）。
- **直列処理**: PostgreSQL は `select … for update` でゲームの行を占有し、`lock_timeout`（既定 3000 ミリ秒）を超えたら `unavailable`（503）。接続プールの待ちの時間切れも同じ。状態の取得は読み取り専用の `REPEATABLE READ` で、占有しない。版の検査（`update … where version = $expected`）は安全装置として残した（食い違えば `VersionConflictError`、利用者には `conflict`）。
- **判定の順**: 認可 → `Idempotency-Key` の検査（欠落・16〜128 文字の範囲外は 422）→ 占有の中で再送の照合 → 状態の検査 → 入力の検証。再送の記録は（ゲーム、操作、呼び出した人、識別子）で一意。確定後に遅れて届いた入力の再送は、前回の結果を返す。
- **コード**: 参加コードは紛らわしい文字を除く 32 種の英数字で 10 文字。進行役用コード・観察者用コード・token は 24 バイト（192 ビット）の乱数に、種類の印（`fac_`、`obs_`、`tok_`）を付ける。照合の鍵は参加コードと観察者用コードに HMAC、進行役用コードと token に SHA-256。参加コードと観察者用コードは AES-256-GCM で暗号化して保存し、進行役が何度でも見られる（`GET /api/games/:id/codes`）。進行役用コードは再表示も再発行もしない。参加コードは大文字小文字・ハイフン・空白を区別しない。
- **鍵**: `CODE_ENC_KEY`（32 バイト）と `CODE_HMAC_KEY`（32 バイト以上）を `<鍵の識別子>:<base64>` の形で環境変数から渡す。無ければ（または不正なら）起動しない（終了コード 1。鍵の値は出さない）。入れ替えの間は `*_PREVIOUS`（「,」区切り）に古い鍵を並べ、復号と照合に使い、新規の保存は新しい鍵で行う。暗号化した値の追加認証データに「ゲームの識別子:コードの種類」を入れ、別の行へ貼り替えた値を復号できなくした。復号に失敗した再表示は `internal` を返す。
- **投影**: 参加者の応答は自分の役割の投影だけ（`mine`、入力済みの数）。小売店だけが当週の顧客需要を受注として見る（将来の需要は含めない）。進行役は全役割の状況と割当てを見る。
- **画面の入力**: 値は「保存する」の操作（またはフォームの送信）で、そのつど保存する。失敗した送信の再実行は同じ識別子を使い、成功したら新しい識別子にする。

## 実測

実行日 2026-11-12。Node.js 26.13.0、PostgreSQL 18（Docker のコンテナ `beer-game3-pg`、ポート 55432、`beer_game3_test`）。

| 区分 | 件数 | 結果 |
| :--- | :--- | :--- |
| 振る舞い（`tests/u1/features`） | 108 | 成功 |
| 単体（`tests/u1/unit`） | 30 | 成功 |
| 結合（`tests/u1/integration`、実際の PostgreSQL） | 21 | 成功 |
| 画面（`tests/u1/web`、jsdom） | 47 | 成功 |
| 合計 | 206 | すべて成功、失敗 0、飛ばした試験 0 |

カバレッジ（`vitest run tests/u1 --coverage`、閾値は `lines: 80`）: 行 94.05%（1218/1295）、文 94.02%、分岐 84.46%、関数 96.04%。除外は `src/server/main.ts` と `src/web/main.tsx`（起動の入口だけ）で、手元のスモークで確かめた。

そのほかの実行:

- `tsc --noEmit`、`eslint .`、`prettier --check .`: 無エラー。
- `npm run build`（`tsc -p tsconfig.build.json` と `vite build`）: 成功。画面は JS 245.7 kB（gzip 76.5 kB）。
- スモーク（手元）: `npm run migrate`（`beer_game3_dev` に 1 件適用）→ `node dist/server/main.js`（ポート 3100）→ `GET /health` が `{"status":"ok","database":"ok"}`、`GET /` が画面の `index.html`（CSP などのヘッダ付き）、`POST /api/games` が 201 でコードを返し、構造化ログが 1 行 1 件の JSON で出た。`CODE_ENC_KEY` を外して起動すると、`startup_refused` を出して終了コード 1。
- 時間の試験: 50 週のゲームの第 50 週の確定が 500 ミリ秒以内（メモリと PostgreSQL の両方で閾値を断言）。入力の保存の応答（1 チーム分 40 回）の p95 が 1 秒以内（PostgreSQL、HTTP 経由）。

## 失敗の確認（BDD の先に失敗させた記録）

| スライド | 実行したコマンド | 失敗の内容 |
| :--- | :--- | :--- |
| A 週の計算 | `vitest run tests/u1/features tests/u1/unit` | `Cannot find module '../../../src/server/domain/engine.js'`（Test Files 1 failed、テスト 0 件） |
| B〜F 作成・参加・開始・入力・確定、鍵とコード | 同上 | 5 ファイルが失敗（`Cannot find module …/access/access-control.js`、`…/access/codes.js`）。既存の 13 件だけが成功 |
| API の入口 | `vitest run tests/u1/features/api-flow.spec.ts tests/u1/unit/http-security-and-logs.spec.ts` | `Cannot find module …/http/app.js`（2 ファイルが失敗） |
| 画面 | `vitest run tests/u1/web` | `Failed to resolve import "../../../src/web/App.js"`（2 ファイルが失敗） |

実装のあと、スライド A は 13 件、B〜F と鍵・コードの単体試験は 96 件（A と合わせて 109 件。初回は 3 件が失敗: 検証の理由に項目の理由を含める、参加拒否の文言を受入条件の語に合わせる、試験の識別子が 16 文字に満たない。いずれも試験の期待が正しく、実装と試験の補助を直した）、API は 21 件、画面は 47 件（初回は試験の補助の spy 化と重複した文言の問い合わせを直した）が通った。リファクタリングは、整数の費用と投影の共通化、`Problem` の統一、枠の組み立ての共通化（`week-state.ts`）、lint の指摘（`==`、不要な代入）の修正で行い、試験は緑のまま。

## 実行しなかったもの（理由）

- **実ブラウザでの画面の操作、キーボード操作とコントラストの自動検査、Playwright、axe-core**: U1 では導入していない（NFR8 は U6）。画面は jsdom と Testing Library でだけ試験した。ビルドした画面の配信（`/`）は curl で確かめたが、ブラウザでの描画は確かめていない。`npm run dev:server` と `npm run dev:web`（tsx、Vite の開発サーバー）も起動していない。
- **負荷試験（75〜270 台）と NFR3.2 の 2 秒以内の反映、通常負荷での NFR3.4**: U6 の仕事。U1 は 1 チーム分の応答と、15 ゲームの並行処理だけを試験した。
- **staging での HTTPS と HSTS の動作**: アプリ側（ヘッダ、`x-forwarded-proto` による転送と拒否）の試験だけ。
- **U1 の CI と staging の自動デプロイ**: 計画どおり作っていない（Q3 の A）。

## 計画・設計からのずれ

1. **既存の仕様の矛盾の解消**: BR5.7（確定済みの週の再送は前回の結果を返す）と BR5.11（確定済みの過去の週は 409）が、識別子が違う再送で食い違う。次のとおり決めた。同じ識別子の再送は常に前回の結果。識別子が違う確定は、進行中なら過去の週・未来の週を 409 `state`。終了済みのゲームの最終週だけは、状態を変えずに前回の結果を返す（`currentWeek` が `weekCount` のまま残り、「当週が確定済み」になるのはこの場合だけのため）。
2. **契約への追加（後方互換）**: `Problem.fields`（項目ごとの理由。`path` と `message`）、`GET /api/me`（資格情報から種類とゲームを返す。再読み込みと進行役の入り直しに必要）、`GET /api/games/:id/codes`（参加コードと観察者用コードの再表示）、`PUT /assignments/:participantId` が `role: null` で未割当てに戻せること、確定・入力・開始・状態の応答の形（`WeekResult`、`DecisionResult`、`GameStateView` の `participants`・`self`・`mine`・`roles`・`assignments`・`unassignedRoles`・`missingInputRoles`・`weekCount`・`name`・`version`）。このタスクでは `contract-summary.md` の編集が許されていないため直していない。**次の工程で `contract-summary.md` に反映が必要**（人の確認事項）。
3. **観察者用コード**: U1 は発行と保存まで。`obs_` の印だけ予約し、資格情報としては受け付けない（403）。U4 が入口を足す。
4. **`GameStateView.status` の `paused`**: 契約にあるが U1 では返さない（U3）。
5. **保存の統合の試験の順序**: PostgreSQL の保存（`pg-store.ts`）は、メモリ上の保存で先に失敗・成功を確かめた振る舞い（同じ約束）を移す形で実装したあとに、結合の試験を書いて実行した。結合の試験が実装前に失敗した記録は取っていない。画面の API クライアント（`api.ts`、`storage.ts`）の試験も、実装のあとに書いた。
6. **試験の件数**: 計画の「およそ 60 件」より多い 206 件（受入条件ごとの境界と、非機能の確かめ方を含めたため）。
7. **進行役の画面**: 計画の S2〜S3 に加え、週の確定に必要な最小の進行管理（役割別の入力状況と確定。S4 の一部）を入れた。一時停止・再開・終了・代理入力・入れ替え・履歴は U3。
8. **12 ステップの進み具合**: 参加者の画面は「⑪ 入力中」で固定した表示（システムのステップは自動で進む前提）。
9. **依存の追加**（外部ライブラリの導入は確認必須のため、人の確認をお願いする）: `tech-stack-decisions.md` に無いもの。`@fastify/static`（ビルド済みの画面の配信）、`tsx`（開発サーバー）、`@vitejs/plugin-react`、`eslint-plugin-react-hooks`、`globals`、`jsdom`、`@testing-library/jest-dom`（画面の試験）。決定表にある Playwright と axe-core は、E2E とアクセシビリティの検査（U6）まで入れていない。

## 版の固定（`package.json`、2026-11-12 に npm で確認）

| 種類 | 版 |
| :--- | :--- |
| 実行 | fastify 5.12.8、@fastify/static 10.1.10、pg 8.23.1、node-pg-migrate 9.0.0、zod 4.6.7、react 19.3.1、react-dom 19.3.1 |
| 開発 | typescript **6.0.3**、vite 8.3.8、@vitejs/plugin-react 6.3.0、vitest 5.1.0、@vitest/coverage-v8 5.1.0、eslint 10.14.0、@eslint/js 10.0.1、typescript-eslint 8.72.2、eslint-plugin-react-hooks 7.1.1、globals 17.14.0、prettier 3.10.0、tsx 4.23.15、jsdom 31.0.0、@testing-library/react 16.3.3、dom 10.4.2、user-event 14.6.9、jest-dom 7.0.1、@types/node 26.6.6、@types/pg 8.23.1、@types/react 19.3.0、@types/react-dom 19.3.0 |

- 候補表との違い: vite 8.3.6 → 8.3.8、typescript-eslint 8.72.1 → 8.72.2、prettier 3.9.10 → 3.10.0（patch の更新）。
- **TypeScript は 7.0.2 が最新だが 6.0.3 に固定した**。typescript-eslint 8.72.2 の対応範囲が `>=4.8.4 <6.1.0` のため（型検査と lint を両立させる）。
- `engines.node` は `>=26.0.0`（弱めていない）。
- `npm audit --omit=dev`: 中程度 3 件（`node-pg-migrate` が依存する `glob` と `minimatch` の助言。移行の実行だけで使い、利用者の入力を渡さない）。`npm audit fix --force` は node-pg-migrate を 7.6.1 に下げる破壊的変更のため実行していない。node-pg-migrate の更新待ち、または Operation で扱う。

## 前のレビューで残った点の解決

| 点 | 解決 |
| :--- | :--- |
| 入力の保存での版の更新 | 保存のたびに版を 1 増やす（参加、割当て、開始、入力、確定のすべて）。入力で `GameStateView.version` が増え、画面が差分を検出できる（`decisions-and-views.spec.ts`）。入力の保存は `games` の 1 行の更新、`week_records` の 1 行の更新、冪等性の記録の追加だけ（集約全体を読み書きしない）。 |
| 無効なコードの試行のログ | 生の接続元は出さない。接続元を `HMAC-SHA-256(照合の鍵, "src:" + 接続元)` の先頭 16 桁（`src`）にして、`forbidden` になった要求のログにだけ付ける（U4 の試行回数の制限が同じ要約で数えられる）。ログの試験で、生の接続元・コード・token・`Authorization` が出ないことを確かめた。`trustProxy` は HTTPS 強制のときだけ有効。 |
| 鍵の識別子の保存先 | 照合用の値は `access_codes.code_hash` に `<鍵の識別子>:<hex>`（HMAC）または `sha256:<hex>`。暗号化した値は `code_sealed` に `v1.<鍵の識別子>.<iv>.<tag>.<暗号文>` として、識別子を値の中に持つ。列は増やしていない。 |
| 資格情報の種類の判定 | 接頭辞の印（`fac_`、`tok_`、`obs_`）で判定する（総当りで試さない）。参加コードは `Authorization` では受け付けず、`/api/games/join` の本文でだけ使う。 |
| コードの衝突の再試行 | `code_hash` の一意制約違反を `CodeCollisionError` にして、`GameSession` が最大 5 回、コードとゲームの識別子を作り直す。5 回続けて重なったら、ゲームを作らず `internal`（試験: `code-collision.spec.ts`、`pg-store.spec.ts`）。 |
| 進行役用コード・観察者用コードのブラウザでの保存 | 進行役用コードは `sessionStorage`（タブを閉じると消える。強い権限のコードを端末に残さない）、参加者の token は `localStorage`（再読み込みで同じ役割に戻る。NFR6.10）。進行役は S0 の「進行役用コードで入る」で、コードだけからゲームを特定して入り直せる（`/api/me`）。観察者用コードの保存は U4。保存先が使えない環境では例外にせず、保存しない。 |
| `functional-spec.md` 40 行目付近の `remainingWeeks` | 「`remainingWeeks` が 1 の枠は次の週に届く」は**誤り**。`entities.md` に従い、**1 は当週に届く（当週の入荷または受注）、2 は次の週に届く**で実装した。第 t 週の出荷・発注・生産要請は第 t+2 週に届く（AC1.5.5、AC1.5.6、AC1.5.7 の試験で確かめた）。`functional-spec.md` の該当の文は直す必要がある（人の確認事項）。 |

## 補足（残件・注意）

- テスト用に Docker のコンテナ `beer-game3-pg`（postgres:18、ポート 55432、データベース `beer_game3_test` と `beer_game3_dev`）を起動したまま残している。不要になったら `docker rm -f beer-game3-pg` で消せる（ほかのコンテナには触れていない）。
- スモークで起動したサーバー（ポート 3100）は終了させた。その際に `pkill -f "dist/server/main.js"` を使ったため、同じコマンド行の別のプロセスがあれば巻き込む可能性があった。実行後に 3000・5173・3100 の待ち受けが無いことと、残っている node が IDE の補助プロセスだけであることを確認したが、事前の一覧は取っていない。以降は PID を指定する。
- `NFR6.6`（HTTPS）と `NFR6.10`（HSTS）のヘッダは、`ENABLE_HSTS=true` のときに有効（staging と production で設定する）。
- 画面の URL のルーティングは持たない（状態の切り替えだけ）。再読み込みは、保存した資格情報から同じ画面に戻る。
