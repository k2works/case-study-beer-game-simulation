# 信頼性の設計 - U5 u5-results-retention

`reliability-requirements.md`（NFR1.1、NFR1.2、NFR2.1〜NFR2.5、NFR5.1、NFR5.2）を満たす設計です。トランザクション、版の検査、障害の扱い、ヘルスチェックは U1 の `reliability-design.md` を、操作と履歴の同時の保存は U3 の `reliability-design.md` を、再起動と切断からの復帰は U4 の `reliability-design.md` を引き継ぎます。

## 設計

| 要件 | 解決 |
| :--- | :--- |
| NFR1.1 結果と出力の内容の再現 | 結果と出力は、確定済みの週の記録（`isConfirmed`）だけを、純粋な関数で整える。時計、乱数、プロセスのメモリに依存しない。終了したゲームは書き込みを受けない（U3 の終了後の拒否）ため、同じゲームの出力は何度取得しても、再起動を挟んでも同じ。試験は、2 回の取得と再起動を挟んだ取得の一致、確定前の入力を含めないことを確かめる |
| NFR1.2 CSV と JSON の一致 | `buildExportRecords(snapshot)` が `ExportRecord` の配列を 1 回だけ作り、`renderCsv(records)` と `renderJson(game, records)` の入力に同じ配列を渡す。列の定義は 1 つの定数（列名の配列）で、CSV のヘッダと JSON の項目名の両方がこれを使う。CSV の引用は RFC 4180（カンマ、二重引用符、CR、LF を含む値を二重引用符で囲み、内部の二重引用符を 2 つにする）。読み戻しの試験は、試験専用の小さな CSV の読み取り関数で records を復元し、JSON の records と件数・順序・値を突き合わせる。性質の試験（ランダムな文字列の表示名: カンマ、引用符、改行、先頭が `=`、日本語、絵文字）でも往復の一致を確かめる |
| NFR2.1 削除の原子性 | `GameSession.deleteIfExpired(gameId, expiredBefore)` が、ゲームの行を `select ... for update` で占有した 1 つのトランザクションの中で、再検査をして、`delete from games where game_id = $1 and status = 'ended'` を実行する。連鎖削除は 1 文の中で行われ、途中の失敗は文ごとロールバックされる。障害の注入の試験は、削除の文の後・コミットの前に例外を起こして、すべての表の行が残ることを確かめる |
| NFR2.2 再検査と冪等 | 自動終了は `GameSession.autoEnd(gameId, staleBefore)` が、占有の中で `status <> 'ended'` かつ `last_operation_at <= staleBefore` を再検査する。結果は `'ended'`（終了した）、`'not-stale'`（選んだあとに操作があった）、`'already-ended'`、`'not-found'` の 4 つを返し、Retention は後ろ 3 つを失敗に数えない。削除は `'deleted'`、`'not-expired'`（条件を満たさなくなった）、`'not-found'`（ほかが先に削除した。`not_found` の例外を結果に直す）の 3 つ。`staleBefore` と `expiredBefore` は、Retention が処理の開始時に `now − autoEndDays`、`now − retentionDays` として計算して渡す |
| NFR2.3 結果の読み取りの一貫性 | 結果と出力は `readSnapshot`（`REPEATABLE READ READ ONLY`）で読む。ゲームが見つからなければ（読み取りの開始より前に削除が完了していた）存在しないゲームと同じ 403 の本文にする。読み取りの開始のあとに削除が完了しても、スナップショットが開始時点の内容を読むため、完全な結果の 200 になる。どちらでも、一部の行だけが欠けた結果や空の結果を 200 で返さない。期待値は 2 通りで、試験は「削除を完了させてから読む」と「最初の問い合わせのあと、2 つ目の問い合わせの前に別の接続で削除を完了させる」の 2 つを置く |
| NFR2.4 失敗が続くゲームの扱い | `FailureMemory`（`retention/failure-memory.ts`）が、直近の処理で失敗したゲームの識別子と再び対象に戻す時刻（失敗の時刻 + 周期）を、プロセスのメモリに最大 1000 件持つ（超えたら古い順に捨てる）。対象を選ぶ問い合わせに `game_id <> all($n::uuid[])` で除外する識別子を渡し、`order by` と `limit` の前に除外する。したがって、失敗が上限件数以上たまっても、除外されたゲームの後ろにある正常なゲームが選ばれる。再起動でメモリは消え、失敗するゲームは再び最初の 1 回だけ選ばれて失敗し、再び除外される。試験は、失敗するゲームを上限と同じ数だけ作り、後ろの正常なゲームが 2 回の処理のうちに処理されることを確かめる |
| NFR2.5 最後の操作の時刻 | `GameTx` に、状態を変える操作（`addParticipant`、`setAssignment`、`insertWeekRecords`、`setDecision`、`replaceParticipant`、`confirmRecords`、`replaceSlots`、`updateGame`）が呼ばれたことを覚える内部の印 `mutated` を持たせる。`GameSession.write`（既存の占有つきの書き込みの入口）が、コールバックの正常終了のあと、印が立っていれば同じトランザクションの中で `tx.touchOperation(clock.now())`（`update games set last_operation_at = greatest(last_operation_at, $1)`）を実行してからコミットする。再送（前回と同じ結果を返すだけ）は、`findIdempotency` の読み取りだけで書き込みを起こさないため、印が立たず、更新されない。閲覧は `write` を通らない。ゲームの作成は `created_at` と同じ値を入れる。終了の保存（`updateGame` による終了）も 1 回だけ更新するが、終了後は書き込みを受けないため、以後は更新されない。移行の補完は `scalability-design.md` の SQL |
| NFR5.1 定期処理の失敗 | `runOnce` は、全体を `try`/`catch` で包み、例外をログに出して `RetentionRunResult`（失敗として）を返す。タイマーのコールバックは `runOnce` の Promise を `catch` するため、未処理の拒否にならない。1 ゲームごとの処理も `try`/`catch` で包み、失敗を `FailureMemory` に記録して次のゲームへ進む。判定は毎回データベースの状態から行う（失敗の記憶と連続の回数は最適化のためのメモリで、無くなっても正しさは変わらない）。通常の要求は、定期処理の例外の影響を受けない |
| NFR5.2 停止 | `scheduler.stop()` が、次の周期を予約しない（`clearInterval`）。実行中の `runOnce` があれば、その Promise を最大 10 秒待つ。実行中の処理は、ゲーム 1 件を処理し終えるごとに「停止の要求があるか」を確かめ、あれば次のゲームを始めずに終える。10 秒を超えたら待つのをやめて閉じる。進行中のトランザクションは、コミットされたか接続の切断でロールバックされたかのどちらかで、部分更新を残さない。ロックは専用の接続の終了とともに解放される。`main.ts` の停止の手順は、タイマーの停止、HTTP の停止、接続プールの終了の順 |

## 障害の扱い

| 障害 | 設計 |
| :--- | :--- |
| 1 つのゲームの失敗 | `FailureMemory` に記録して次のゲームへ。1 周期のあいだ選択から外す。ログは `warn` |
| 全体の失敗（データベースの接続など） | `error` でログに出し、その回を終える。連続の失敗の回数を 1 増やす。次の周期でやり直す |
| ロックを取れない | `info` で skipped を出す。連続の失敗の回数は変えない |
| 結果と出力の読み取りの失敗 | 503 `unavailable`（`Problem`）。空の結果を返さない |
| 停止の要求 | 次の周期を予約せず、実行中のゲームの保存の終わりを最大 10 秒待つ |

## 上流の資料

`reliability-requirements.md`、`functional-spec.md`、`rules.md`、`entities.md`、`contract-summary.md`
