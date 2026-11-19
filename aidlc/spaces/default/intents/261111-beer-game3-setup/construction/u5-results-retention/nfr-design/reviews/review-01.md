## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-13T05:55:26Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-design/security-design.md > NFR7.2 削除の範囲と痕跡（reliability-design.md > NFR2.1 削除の原子性も同じ前提） | 設計は「`week_records.decided_by_participant_id` は連鎖のない参照だが、参照元と参照先が同じ文の中で削除されるため、文の終わりの検査を通る」と断定している。しかし `1763000000000_u3-facilitation.sql` では、この列は `references participants (participant_id)`（NO ACTION、遅延なし）で、`games` からの連鎖削除は `participants` と `week_records` へ別々の連鎖の文として実行される。`participants` の表は `week_records` より先に作られているため、`participants` の連鎖が先に走り、その時点で `week_records` の行が残っていれば、NO ACTION の検査が違反になりうる。成立の根拠が書かれておらず、成立しなかった場合の代替の設計がない。成立しないと、入力者が参加者の週を持つゲーム（ほぼ全てのゲーム）が削除できず、NFR2.1・NFR7.2 が満たせない。設計は「試験で確かめる」としか書いておらず、試験が落ちたときに実装者が推測で直すことになる | 削除の順序を設計で確定する。たとえば (a) `deleteGame` が同じトランザクションの中で、先に `update week_records set decided_by_participant_id = null where game_id = $1` か `delete from week_records where game_id = $1` を実行してから `delete from games` を実行する、または (b) 新しい移行で外部キーを `on delete set null`（または `deferrable initially deferred`）に変える。どちらを採るかと、原子性（NFR2.1）が保たれる理由を security-design.md と reliability-design.md に書く。「1 文で成立する」という断定は、選んだ方式の記述に置き換える | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-design/observability-design.md > NFR9.2 重大度と連続の失敗 および 連続の失敗の回数の遷移（reliability-design.md > NFR2.4 との組み合わせ） | `FailureMemory` は失敗したゲームを「失敗の時刻 + 周期」まで除外する。失敗の時刻は処理の開始より後なので、次の回の開始時刻（開始 + 周期）はまだ除外の期間内にあり、そのゲームは次の回で選ばれない。その回は `failed = 0` の「失敗なしの成功」になり、`consecutiveFailures` が 0 に戻る。その次の回で再び選ばれて失敗する。つまり恒久的に失敗する 1 ゲームでは「失敗、成功、失敗、成功」を繰り返し、連続の回数が 3 に届かず、NFR9.2 の「直近 3 回が連続して失敗したら `error`」（`retention_run_repeated_failure`）は、全体の失敗の場合にしか出ない。設計内の NFR2.4 と NFR9.2 が干渉している。また、除外の解除の境界（`now` が戻す時刻と等しいとき）が定義されておらず、固定の時計を使う試験では結果が変わる | 連続の失敗の数え方を、除外の仕組みと矛盾しない形に定める。たとえば「除外されたゲームが残っている回は、失敗なしの成功として 0 に戻さず、前の値を保つ」または「`FailureMemory` が除外中のゲームを数え、その数が 1 以上の回は失敗として扱う」。あわせて、除外の解除の境界（`now >= 戻す時刻` で戻す）を `FailureMemory` の仕様に書き、観測性の遷移の表を直す。試験は、恒久的に失敗する 1 ゲームで 3 回目に `error` が出ることを確かめる形にする | New |
| R-03 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-design/performance-design.md > NFR3.4 定期処理の影響（scalability-design.md > 索引と移行） | 削除の 1 ゲーム 1 秒以内という前提に対して、`week_records.decided_by_participant_id` には索引がない（u3 の移行は列を足しただけ）。参加者の行を連鎖で削除するたびに、NO ACTION の検査が `week_records` を全件走査しうる（最大 3000 件 × 200 行 = 約 60 万行 × 参加者数）。`role_assignments.game_id` も索引がない。設計の索引の一覧にも言及がない | `1763200000000_u5-results-retention.sql` に `week_records (decided_by_participant_id)` の索引を足すか、足さない理由（走査の見積もり）を scalability-design.md に書く。`role_assignments (game_id)` も同様に判断する | New |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-design/scalability-design.md > 索引と移行 | 移行の記述に Down Migration がない（既存の 4 本の移行はすべて Up/Down を持つ）。また部分索引 `games_stale_idx`（述語 `status <> 'ended'`）を使うには、対象を選ぶ問い合わせの述語が同じ形である必要があるが、選択の問い合わせの条件の形（`status <> 'ended'` か `status in (...)` か）が設計に書かれていない（後者だと索引が使われない） | 移行に Down（索引と列を落とす）を書き、`findStaleGames` と `findExpiredGames` の SQL の述語を、部分索引の述語と同じ形で設計に明記する | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-design/security-design.md > NFR7.2 と NFR6.7 | NFR7.2 は削除を `delete from games where game_id = $1` の 1 文としているが、NFR6.7 と reliability-design.md の NFR2.1 は `status = 'ended'` を条件に含める。設計内で削除の文の条件が食い違っている | NFR7.2 の記述を `delete from games where game_id = $1 and status = 'ended'` に揃える（上の Major の方式を決めたあとにまとめて直す） | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-design/observability-design.md > NFR9.1 定期処理の結果 | ゲームごとの削除のログの時刻の項目名が `at` だが、Functional Design の BR24.6 は `event、gameId、deletedAt、reason` を挙げている。また security-design.md の NFR6.6 が出す `retention_config_shorter_than_default` は、logical-components.md の構造化ログの一覧（`retention_config` のみ）にない | 項目名を BR24.6 の `deletedAt` に揃えるか、`at` とする理由を書く。ログの種類の一覧に `retention_config_shorter_than_default` を足す | New |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-design/reliability-design.md > NFR2.5 最後の操作の時刻 | 「終了の保存も 1 回だけ更新する」は BR25.2（終了も更新する操作に挙げる）に合うが、`entities.md` の Game.lastOperationAt の制約「終了したゲームでは更新しない」と食い違う。設計がどちらに従うかを明示していない | 設計に「終了の保存での更新は BR25.2 に従う」と明記し、`entities.md` の制約文の直しを引き渡し事項に挙げる（またはそれに合わせて `finish` では更新しない設計にする） | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| traceability.json の手作業の照合（NFR Requirements の NFRx.y 39 件との突き合わせ） | 39 件すべてが upstream_ids と coverage に載り、target の設計の記述は各設計文書に実在する。NFR10 は上流で N/A | 網羅に欠けはない |
| 実装済みコードの確認（`readSnapshot` が `REPEATABLE READ READ ONLY`、`GameSession.write` が `store.transact` の薄い包み、`transact` が `select ... for update` と `lock_timeout`、`pg_advisory_xact_lock(int, int)` の使用、`on delete cascade` の連鎖、`join-sweeper.ts` の形） | 設計の主張と一致。ただし `week_records.decided_by_participant_id` は連鎖のない参照のまま（上の Major） | 連鎖削除の順序は設計で確定が必要 |
| 空配列の `game_id <> all($n::uuid[])` | PostgreSQL では空配列に対して真になり、除外なしの意味で正しい | 問題なし（設計に明記すると親切） |
| sensors（required-sections、upstream-coverage、linter、type-check、traceability） | 依頼どおり、エンジンが別に確かめる。私は実行していない | 該当なし |

### Summary

NFR の網羅、アドバイザリロックの専用の接続、`mutated` の印による `last_operation_at` の更新、再検査と結果の区別、`REPEATABLE READ` のスナップショットの 2 通りの期待値は、実装済みのコードと整合し、実装者が作れる水準です。最大の懸念は、連鎖のない `decided_by_participant_id` を含む削除が 1 文で成り立つという断定に根拠も代替もないこと（削除の中核）と、`FailureMemory` の除外が連続の失敗の検知（NFR9.2）を無効にする干渉です。この 2 件（Major 2 件）を直せば、設計は実装に進めます。
