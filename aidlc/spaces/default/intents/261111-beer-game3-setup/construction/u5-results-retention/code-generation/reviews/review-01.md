## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-13T07:15:55Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | apps/beer-game3/tests/u5/integration/retention-pg.spec.ts > describe 'NFR2.4 NFR3.4 定期処理（実際の PostgreSQL）' の 2 件（失敗するゲームが上限と同じ数あっても…、200 件の対象を 1 回の処理で扱う…） | この 2 件は vitest の既定の時間切れ 5 秒に対して、実測 3.9〜5.3 秒かかる。レビュー中の実行で、1 回目の結合試験の実行では失敗し、2 回目と 3 回目は通り、別の実行では 200 件の試験が `Test timed out in 5000ms`（5272ms）で落ちた。同じコードで通ったり落ちたりする。code-summary.md も「200 件で約 4.5 秒」と記録しており、時間切れの余裕がほぼない。チームの規則で CI の全試験が merge の条件なので、間欠的に CI を落とす。 | 2 件に個別の時間切れ（たとえば 60 秒）を指定する。または対象件数の準備（`insert ... generate_series` と 4 ゲームの作成）を `beforeAll` に移す。NFR3.4 の目標（1 回 5 分以内、1 件 1 秒以内）の判定は、試験の時間切れとは別に、実測値の `expect` で行っているので、そのまま残す。直したあと、結合の試験を繰り返して安定を確かめる。 | New |
| R-02 | Minor | apps/beer-game3/src/server/main.ts（起動の組み立て、停止の手順）と aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/performance-requirements.md > NFR3.5、reliability-requirements.md > NFR5.1 | NFR3.5（対象 200 件のデータベースで起動しても、最初のヘルスチェックまでの時間が変わらない）と NFR5.1（定期処理の障害の最中に、同時に送った取り直しと入力が成功する）は、NFR 要件が「U5 の自動試験」を指定している。該当する試験が `tests/u5` に見つからない（`NFR3.5`、`NFR5.1` の語は試験にない）。scheduler の単体試験は `firstRun` を待たずに始まることだけを確かめる。`main.ts` はカバレッジの対象外で、起動のスモークも未実施（code-summary.md に記載あり）。traceability.json の NFR3 と NFR5 は試験でなく実装のファイルを指して OK としている。`listen` のあとに定期処理を始める順序と、停止の順序（タイマー、HTTP、接続プール）は、コードを読んだ限りは設計どおり。 | `buildApp` と `RetentionJob` を組み合わせた結合の試験を足す。内容は、200 件の対象を持つデータベースで定期処理を始めても `/health` が即座に答えること、定期処理の途中で障害を注入しても同時の取り直しと入力が成功すること。足さないなら、traceability.json の該当行を、未検証であることが分かる形に直すか、手元のスモークを人の確認として記録する。 | New |
| R-03 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/code-generation/code-generation-plan.md > Step 14 | 承認済みの 16 Step のうち Step 14 が未完了（`[ ]`）のまま。実機のブラウザ確認と Playwright による 50 週の描画時間の実測（NFR8.1、NFR8.2）は実行されていない。jsdom の試験は通っているが、NFR8.2 の「結果の応答のあと 1 秒以内」は jsdom の測定（実機の描画ではない）しかない。これは既知の未実施で、単独では NOT-READY の根拠にしない。 | 人が実機で、キーボード操作、線種と印の見分け、50 週の描画を確かめ、結果を Step 14 に記録して完了にする。確認できない間は、NFR8 を未検証として残す。 | New |
| R-04 | Minor | apps/beer-game3/src/server/main.ts > shutdown | `SIGTERM` が 2 回来ると `shutdown` が重なって走り、`app.close()` と `store.close()` を 2 回呼ぶ。また、10 秒の待ちが切れたあとも実行中の保存があると、`store.close()`（`pool.end()`）と競合する。後者は保存がコミットか巻き戻しのどちらかになるだけなので、データは壊れない。 | `shutdown` に再入の防止（1 回だけ実行する）を足す。必須ではない。 | New |
| R-05 | Minor | apps/beer-game3/src/server/reporting/csv.ts > const BOM（および src/server/session/schemas.ts > FORBIDDEN_DISPLAY_NAME_STARTS） | BOM が目に見えない U+FEFF の文字そのものとしてソースに書かれている。レビューや編集で消えても気づきにくい（試験が BOM を確かめているので、消えれば落ちる）。`FORBIDDEN_DISPLAY_NAME_STARTS` のタブと復帰は、直前の `trim()` が先に取り除くため、判定としては働かない（害はない。コメントは防御として説明している）。 | BOM は `'﻿'` と書く。タブと復帰の項目は、残すなら「trim の定義が変わった場合の備え」であることを試験で固定するか、外す。 | New |

### 検証した内容（根拠）

**実行した検証**

- Unit・振る舞い・画面（`tests/u5/features tests/u5/unit tests/u5/web`）: 21 ファイル 194 件がすべて通った。
- 結合（`tests/u5/integration`、`beer_game3_test`）: 1 回目は 20 件中 1 件が失敗（上の Major の時間切れ）。2 回目は 20 件すべて通り、3 回目は 200 件の試験が時間切れで落ち、4 回目は通った。
- U1〜U4 の既存の試験（`tests/u1 tests/u2 tests/u3 tests/u4`、`DATABASE_URL` あり）: 47 ファイル 504 件がすべて通った。504 件と U5 の 214 件で、code-summary.md の 718 件と一致する。
- `npx tsc --noEmit` と `npx eslint .`: エラーなし（出力なし）。
- `vitest.config.ts` の `thresholds`（lines 80）は、直前のコミットから差分なし。カバレッジの閾値は弱められていない。

**コードの確認で、主張どおりと確かめたもの**

- BR25.2 `last_operation_at`: `GameSession.write` が `tx.mutated` のときだけコミット前に `touchOperation` を呼ぶ（`greatest`）。再送、閲覧、拒否では更新されない。試験が各操作で網羅している。
- `autoEnd` と `deleteIfExpired`: 行の占有の中で再検査し、結果を `ended`、`not-stale`、`already-ended`、`not-found`（`deleted`、`not-expired`、`not-found`）に区別している。期限の境界は「以降」（`<=`）で `policy.ts` と一致する。
- `runExclusive`: 専用の接続で `pg_try_advisory_lock` を取り、ゲームの処理はプールの別の接続を使う。解放に失敗した接続は `release(true)` で破棄する。取れなければ待たずに `acquired: false`（skipped）。
- 失敗の除外: `game_id <> all($3::uuid[])` を並びと上限の前に適用する。連続の失敗の回数は、失敗で増え、成功で 0 に戻り、skipped では変わらない（scheduler.ts）。停止は `requestStop` と最大 10 秒の待ち。
- 削除の原子性: `delete from games where game_id=$1 and status='ended'` の 1 文で、外部キーの連鎖により子の表が同じ文の中で消える。`week_records.decided_by_participant_id` は連鎖のない参照だが、同じ文の中で両方消えるため問題にならない（試験あり）。
- `readSnapshot`: `REPEATABLE READ READ ONLY` の 1 つのトランザクション。読み取りの途中の削除で完全な 200 が返る試験がある。
- 認可: `authorize` と `requireResultsViewer`/`requireExporter` は、観察者、資格情報なし、別のゲーム、削除済みを、同じ `invalidCredentialError()`（403）にする。進行役でも終了前の結果は 403、出力は 409（BR21.1、BR23.1）。
- 出力: `ResultsView` と `ExportRecord` は許可リストの専用の型で、項目を 1 つずつ写している。CSV は RFC 4180、BOM、CRLF、値を変えない。CSV と JSON は同じ `ExportRecord` から作る。応答に `attachment`、`no-store`、`nosniff`、ファイル名は gameId だけ。ログは `results_served`/`export_served`（gameId と件数のみ）、`game_deleted`/`game_auto_ended`（gameId と時刻と理由のみ）。
- 構造: ESLint の `no-restricted-imports` が `src/server/http/**` から `game-session`、`reporting`、`retention` の import を禁じる。`main.ts` だけが定期処理を組み立て、HTTP の入口はない。
- 表示名: `schemas.ts` の `displayName` に集約し、trim 後に `= + - @` で始まる名前を 422 にする。占有の前に検証する（プロジェクトの規則と一致）。
- 移行: `last_operation_at` を既存の行から最も遅い時刻で補完し、部分索引 2 つを足す。Down で元に戻る。`default now()` を残し、ローリングデプロイの旧版の挿入も通る。

**逸脱の妥当性**

- code-summary.md の逸脱 1〜6 は、すべて設計の規則（BR23.10 の「占有の前」、BR25.4 の期限の引数、移行が増えたことによる down 件数）から出たものである。U1〜U4 の試験の変更は、仕様の変更に追随するだけで、検証を緩めていない。U1〜U4 の 504 件はすべて通る。
- 赤の記録は、実装前の失敗の件数と内訳が具体的で、妥当である。順序の逸脱がないという記述も、試験の構成と矛盾しない。

**範囲外とした項目**

- 実機のブラウザ確認と Playwright の描画時間の実測は、既知の未実施として、Minor（Step 14）に留めた。

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| vitest（U5 の features、unit、web） | 21 ファイル 194 件が通った | 振る舞い、単体、画面は緑 |
| vitest（U5 の integration、PostgreSQL） | 間欠的に失敗（20 件中 1 件、時間切れ 5 秒）。再実行で通ることも、また落ちることもある | 試験の時間切れの余裕不足による不安定。実装の誤りではない。Major として報告 |
| vitest（U1〜U4 の回帰） | 47 ファイル 504 件が通った | 既存の振る舞いを壊していない |
| tsc --noEmit | エラーなし | 型は整合 |
| eslint | エラーなし | 入口の import 制限を含めて通る |

### Summary

実装は設計（BR21〜BR26、NFR）と整合しており、認可、原子性、ロック、再検査、ログの扱いに構造的な欠陥は見つからなかった。主な懸念は、PostgreSQL の結合試験 2 件が既定の 5 秒の時間切れすれすれで、CI で間欠的に落ちること（Major 1 件）と、起動の入口の配線（NFR3.5、NFR5.1）の試験が計画どおりには存在しないこと（Minor）である。Critical なし、Major 1 件のため READY とする。
