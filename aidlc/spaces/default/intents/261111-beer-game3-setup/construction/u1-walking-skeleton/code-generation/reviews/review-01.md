## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-12T05:14:07Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | apps/beer-game3/src/server/session/schemas.ts > createGameSchema（initialInventory、initialPipelineQuantity、inventoryUnitCost、backlogUnitCost、demandSeries の各値）と apps/beer-game3/migrations/1762900000000_u1-schema.sql > game_settings、demand_series、week_records の integer 列 | 上限のない非負整数を受け付けるが、保存先は 32 ビット整数の列。実際に PostgreSQL 18 の保存で確かめた。`initialInventory: 3000000000` と `demandSeries: [3000000000]` は 422 ではなく 500 `internal` でゲームの作成に失敗する。`inventoryUnitCost: 1000000000` は作成も開始も 4 人の入力も通るのに、週の確定が 500 `internal` で失敗し、そのゲームは 1 週目から進められなくなる（復旧の手段がない）。BR1.1〜BR1.3 の検証が値の範囲を覆っておらず、BR5.9 の「失敗しても確定前のまま」は守られるが、利用者には直し方が示されない | 設定の各値に、列の範囲と週次費用・累積費用が収まる上限を決めて zod の検証に入れ、範囲外は 422 `validation`（項目と上限を案内）にする。需要系列の各値の上限も決める。上限ぎりぎりの値でも 50 週の累積費用が列に収まることを確かめる試験（ゲーム作成と週の確定）を足す | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/contract-design/contract-summary.md > components.schemas.Problem、GameStateView、paths と、apps/beer-game3/src/server/http/app.ts、session/projection.ts、session/game-session.ts | 実装した入口が共有の契約を超えている。契約にないもの: `Problem.fields`、`GET /api/me`、`GET /api/games/:gameId/codes`、`PUT /assignments/:participantId` の `role: null`（未割当てに戻す）、`WeekResult`・`DecisionResult` の応答の形、`GameStateView` の `name`・`weekCount`・`version`・`participants`・`self`・`assignments`・`unassignedRoles`・`roles`・`missingInputRoles`。契約の `GameStateView` は 5 項目だけを必須にしており、U2〜U6 と別チームの画面・試験が実装の形を推測するしかない。code-summary.md は未反映を認めているが、承認の前に契約へ戻されていない | 契約（contract-summary.md）に上記の追加を後方互換の項目として記載し、`GameStateView` の必須項目と各応答の形を実装に合わせる（または実装のうち契約に入れない項目を決めて外す）。反映の人の確認を承認の条件にする | New |
| R-03 | Minor | apps/beer-game3/src/server/http/app.ts > Fastify の `trustProxy: deps.enforceHttps`、`access.sourceDigest(request.ip)` | `trustProxy: true` は経路上のすべての転送元を信頼するので、`x-forwarded-for` の先頭（利用者が自由に付けられる値）が `request.ip` になる。U4 の試行回数の制限（NFR6.8）が、この `src` の要約で数える前提のため、ヘッダを変えるだけで数えられない | 信頼する転送の段数（または ALB の範囲）を明示して `trustProxy` を絞り、右端から数えた接続元を使う。U4 に、この要約を数える鍵として使う前提と留意を引き継ぐ | New |
| R-04 | Minor | apps/beer-game3/src/server/http/app.ts > `PUT .../decisions/:role`、`POST .../confirm` の経路（`parseWeek` を `session.*` の前に実行） | 週の書式の誤りの検査（422）が、認可（403）より先に走る。資格情報のない呼び出しが、`week=abc` で 422 を、正しい書式で 403 を受け取るため、判定の順（認可 → 再送 → 状態 → 検証、BR4.8）と食い違う。情報の漏れは小さいが、順序の約束を試験が守らせていない | 週の書式の検査を認可のあとへ移す（`session` の中で行う）。認可なしで不正な週を送ったときに 403 になる試験を足す | New |
| R-05 | Minor | apps/beer-game3/src/server/session/week-state.ts > engineStateAtWeekStart（`previous?.inventory ?? 0` など） | 第 2 週以降で前の週の確定済みの記録が見つからないとき、在庫・受注残・累積費用を黙って 0 にして計算を続ける。記録の欠損を、誤った数値の確定として保存してしまう（データの破損が見えなくなる） | 前の週の確定済みの記録が無い場合は `internal` で失敗させる（0 を代入しない）。その試験を足す | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/functional-spec.md > 40 行目付近 | 「`remainingWeeks` が 1 の枠は次の週に届き」は、同じ文書の入荷の定義（88 行目）、rules.md の BR5.4、entities.md の定義（1 は当週に届く）と矛盾する。実装は後者に従っており正しいが、設計の文書が実装の読み手を誤らせる | 該当の文を「1 は当週に届く、2 は次の週に届く」に直す | New |
| R-07 | Minor | apps/beer-game3/package.json > 新規の依存（`@fastify/static`、`tsx`、`@vitejs/plugin-react`、`eslint-plugin-react-hooks`、`globals`、`jsdom`、`@testing-library/jest-dom`）、typescript 6.0.3、node-pg-migrate 9.0.0 | 技術スタックの決定表にない依存を、事前の承認なしに入れている（確認必須の外部ライブラリの導入）。`npm audit --omit=dev` は node-pg-migrate 経由の glob・minimatch の中程度 3 件を出す（実行して code-summary.md と一致を確認）。TypeScript は typescript-eslint の対応範囲のため最新より 1 つ前に固定している | 追加した依存を技術スタックの決定表に反映し、人が承認する。node-pg-migrate の助言は、移行の実行だけで使い利用者の入力を渡さないことを理由と期限つきで受け入れの記録に残し、TypeScript 7 へ上げる条件（typescript-eslint の対応）も記録する | New |
| R-08 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/code-generation/code-summary.md > 計画・設計からのずれ 5、apps/beer-game3/src/server/session/pg-store.ts、apps/beer-game3/src/web/api.ts、storage.ts | 「振る舞いの例と失敗する試験を実装より先に定義する」（BDD の約束）に対し、PostgreSQL の保存（617 行）と画面の API クライアントは、実装のあとに試験を書いた。メモリ上の保存で振る舞いを先に固定しているため影響は限られるが、2 つの保存の実装（メモリと PostgreSQL）が食い違う危険が残る（結合の試験 21 件が補っている） | 次の Unit からは、保存の境界の振る舞いも同じ試験を両方の保存に適用する形（共通の契約試験）で、実装より先に失敗を確かめる。必要なら U1 の PostgreSQL 保存に、メモリ保存と同じ振る舞いの例を流す共通試験を足す | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| `npm run verify`（`DATABASE_URL=postgres://postgres:postgres@localhost:55432/beer_game3_test`、Node 26.13.0） | PASS。tsc 無エラー、eslint 無エラー、prettier「All matched files use Prettier code style!」、vitest「Test Files 15 passed (15) / Tests 206 passed (206)」、カバレッジ 行 94.05%（1218/1295）・文 94.02%・分岐 84.46%・関数 96.04%、閾値は `lines: 80` のまま | code-summary.md の 206 件・94% の主張と一致。閾値は下げられておらず、除外は `main.ts` と `web/main.tsx` だけ |
| 区分別の再実行（features / unit / integration / web） | 108 / 30 / 21 / 47 件が成功 | 件数の内訳が code-summary.md と一致 |
| 手計算と週の計算の突き合わせ（engine.ts、week-calculation.spec.ts） | 一致 | `[当週, 次週]` の枠を、確定のたびに先頭を消費・末尾を前進・新しい値を末尾へ入れる実装で、第 t 週の出荷・発注・生産要請は第 t+2 週に届く。初期の枠（`remainingWeeks 1` が当週）は第 1 週の入荷・受注になる。AC1.5.3（出荷 16、在庫 0、受注残 4）、AC1.5.4、AC1.5.9（800）、AC1.5.5〜AC1.5.7 は試験が実際の差で確かめる。常に通る断言は見つからなかった（`toBeDefined` は例外が出ないことの確認に限られる） |
| 実測: 上限のない設定値でのゲーム作成と週の確定（スクラッチの tsx スクリプト、PostgreSQL 18） | `initialInventory`・`demandSeries` の 3,000,000,000 は作成が `internal`、`inventoryUnitCost` 1,000,000,000 は開始まで通り週の確定が `internal` | 最初の Major の根拠。作った行は削除した |
| `npm audit --omit=dev` | 中程度 3 件（glob、minimatch、node-pg-migrate） | code-summary.md の記載と一致 |
| traceability.json の対象ファイルの存在確認 | 98 件の ID すべてに対応があり、対象のファイルはすべて存在（OK 89、Deferred 9 は対象なしで U4〜U6 の理由つき）。各対象は ID の内容と関連している | 問題なし |
| セキュリティの確認（access-control.ts、keys.ts、codes.ts、app.ts、pg-store.ts、config.ts） | 問題なし（上記の Minor を除く） | 進行役用コード・token は SHA-256、参加コード・観察者用コードは HMAC-SHA-256 の照合と AES-256-GCM（毎回 12 バイトの新しい IV、ゲーム ID とコード種別を追加認証データに入れる）。資格情報は種類の印で判定し、失敗は一様に 403。SQL はすべて引数化（`any($2::text[])`、`unnest`）。ログは許可した項目だけで、本文・Authorization・生の接続元を出さない。鍵が無いと終了コード 1 で起動を拒否する。投影は呼び出した人の役割だけから作り、小売店の需要は当週のみ |
| 同時実行の確認（pg-store.ts transact、pg-store.spec.ts） | 問題なし | `select … for update` と `set_config('lock_timeout', …, true)`（既定 3000 ms）、55P03 を `unavailable` に変換。確定は 1 トランザクション（記録・枠・週の進行・冪等性の記録）。冪等性の一意性は（ゲーム、操作、呼び出した人、識別子）で、DB の一意制約と照合の両方がある。順番待ちの上限、別ゲームの非待機、読み取りの非待機、同時確定を実 DB で試験している |

### Summary

週の計算、遅延の枠、権限と秘密の扱い、1 トランザクションでの確定は、設計どおりで、206 件の試験と 94% のカバレッジも主張どおり再現できた。直すべき主な点は、設定値に上限がなく DB の 32 ビット整数の範囲を超えると 500 になる、または確定できないゲームが作れること（実測で確認）と、実装が足した入口の形が共有の契約に戻されていないことの 2 つ（Major 2 件、Critical なし）で、ほかは Minor のため READY とする。
