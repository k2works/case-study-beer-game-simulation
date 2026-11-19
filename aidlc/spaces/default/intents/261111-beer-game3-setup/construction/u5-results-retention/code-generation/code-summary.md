# コード生成の概要 - U5 u5-results-retention

## 作成・変更したファイル

アプリ（`apps/beer-game3/`）。一覧の正本は `source-manifest.json`。

- 移行: `migrations/1763200000000_u5-results-retention.sql`（`games.last_operation_at`、補完、部分索引 2 つ、Down）
- 保存とセッション: `session/{store,memory-store,pg-store,game-session,schemas}.ts`、`domain/types.ts`（`DISPLAY_NAME_MAX`）
- 新規 `reporting/{results,export,csv,reporting}.ts`、`retention/{policy,failure-memory,job,scheduler}.ts`、`env.ts`
- 入口と認可: `access/{access-control,session-gateway}.ts`、`http/{routes,app}.ts`、`config.ts`、`main.ts`、`eslint.config.js`
- 画面: `web/{api,chart,format,messages,styles}`、`ResultsChart.tsx`、`screens/{ResultsScreen,ExportPanel,GameScreen,FacilitatorBoard,JoinScreen,PlayScreen}.tsx`
- 試験: `tests/u5/`（features 6、unit 8、integration 2、web 7 ファイル）、既存試験の更新（下記の逸脱）
- 設定・文書: `package.json`（`test:u5` ほか）、`.env.example`、`README.md`、`contract-summary.md`（C1 と C5）、U1 の BR2.5、U5 の functional-spec

## 主な実装の判断

- `GameTx.mutated` と `touchOperation`: `GameSession.write` が、書き込みがあったときだけコミット前に 1 回 `last_operation_at` を更新（`greatest`）。再送・閲覧・拒否では更新されない。
- 削除は `delete from games where game_id=$1 and status='ended'` の 1 文（外部キーの連鎖）。`deleteIfExpired` は占有の中で再検査。
- `runExclusive` は専用の接続で `pg_try_advisory_lock(hashtextextended(key,0))`。解放に失敗した接続は破棄。ゲームの処理は別の接続。
- 失敗したゲームは `FailureMemory` で 1 周期除外（`game_id <> all($n::uuid[])`）。連続の失敗の回数は failed のみ増やし、skipped は変えない。
- 結果と出力は `readSnapshot`（REPEATABLE READ READ ONLY）。許可リストの専用の型。ログは `game_deleted`（gameId・deletedAt・reason）、`game_auto_ended`（gameId・at・reason）。
- 表示名は `schemas.ts` の `displayName` に集約（trim 後に先頭が `= + - @ タブ 復帰` なら 422）。
- 画面: SVG のグラフ（線種・印・凡例、印は 25 週超で 5 週ごと）、表の併記、ラジオで指標・費用の切り替え。外部ライブラリは追加していない。

## 試験の概要

- 全体: 70 ファイル 718 件が緑（U5 で 214 件を追加）。カバレッジ 行 94.5%、分岐 86.15%（閾値 行 80% は不変）。`npm run verify`（型検査・lint・format・カバレッジつき全試験、`DATABASE_URL` あり）が成功。
- U5 の部品の行カバレッジ: reporting 93%前後、retention 97%前後、ExportPanel と ResultsScreen は画面の試験で 85% 超。
- 記録した測定: 50 週のゲームの結果・CSV・JSON は単独で数十 ms 以内、出力は 100 KB 未満（`performance.spec.ts`）。200 件の対象を 1 回で処理: 約 4.5 秒（1 件あたり約 22 ms、`retention-pg.spec.ts`）。50 週の結果画面の描画は jsdom で 1 秒未満。

## 実行しなかった試験とその理由

- ブラウザでの実機の確認と Playwright の画面の試験（Step 14 の後半、NFR8 の描画時間の実測）: ブラウザ拡張に接続できず実行できなかった。画面は jsdom の試験（キーボード操作、線種・印、表の併記、注意と列名の同時表示、導線）で確かめた。開発用 DB には `npm run migrate` を 1 回適用済みで、開発サーバー（3100）と画面（5273）は止めていない。目視は人の確認に残す。
- U6 の負荷試験・コントラストの全体検査・主要ブラウザの検査: 範囲外（u6-nfr-verification）。
- 起動の入口 `main.ts`（カバレッジの対象外）の起動時の動作は、手元のスモークとしては未実施。部品（スケジューラ、設定の読み込み、起動時のログ）は単体で確認した。

## 計画からの逸脱

1. 参加（join）の表示名の検証を、コードの検証のあと・占有の前に移した（BR23.10 の「占有の前」に従う）。進行中のゲームへの不正な名前は 409 でなく 422 になる。U1 の試験は変更なしで緑。
2. `autoEnd` の引数が `(gameId, staleBefore)` で必須になった。U3 の試験（`lifecycle.spec.ts`）を更新。
3. 移行が 1 つ増えたため、`down` の件数に依存する既存の結合試験（U2 の 3→4、U3 の 2→3、U4 の 1→2）を更新。U4 の `access-control.spec.ts` は参加者の結果の閲覧を許す形に更新。`tests/u1/web/support.tsx` の `fakeApi` に新しい API を追加。
4. `DISPLAY_NAME_MAX` を zod を含まない `domain/types.ts` へ移した（ブラウザの束に zod が入らないように）。
5. `createServices` が `session` も返す（`main.ts` の定期処理のため。入口は使わない）。
6. 構造の試験の追加: 入口が reporting と retention を import しない（ESLint の制限も追加）、`games` を参照する外部キーの連鎖（静的な検査）。

## スライド A の赤の記録（Step 2）

実装前に、スライド A〜E の試験を先に書いて流した。結果（抜粋）:

- メモリ上の保存・単体・画面: `Test Files 17 failed (17)`、`Tests 14 failed | 14 passed (28)`。失敗の内訳は、`lastOperationAt` が未定義（`expected undefined to deeply equal 2026-11-12T10:00:00.000Z`）、`show-results` / `export-panel` / `join-name-rule` / `replace-name-rule` が見つからない、構造の試験（`retention` を import するのは `config.ts` と `main.ts`、`reporting` は `access/session-gateway.ts`、経路の表の 2 行）が空、および `retention/*`・`reporting/*`・`ResultsScreen`・`ExportPanel` が存在せず読み込めないスイート。
- PostgreSQL の結合: `Test Files 2 failed (2)`、移行の試験 `Tests 3 failed (3)`（`last_operation_at` の列がない）、`retention-pg.spec.ts` はモジュールが無く失敗。
- その後、スライドごとに最小の実装を入れて緑にした（A: `last-operation`・`display-name`、B: `retention`・`job`・`scheduler`・PG の結合、C/D: `results`・`export`・`access-matrix`・`reporting`・`csv`、E: 画面の 3 ファイル）。順序の逸脱（後続の試験より先に実装を書いた箇所）はなかったため、規則を壊した確認は不要。
