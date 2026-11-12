## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-12T07:42:53Z
**Iteration:** 2
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/nfr-design/performance-design.md > NFR3.2 進行管理の投影、および scalability-design.md > NFR4.3 | 進行管理の投影は「読み取り専用の短いトランザクション」で games、WeekRecord、PipelineSlot、Participant、RoleAssignment を複数回に分けて読み、占有しないとある。分離水準の指定がない。PostgreSQL の既定（READ COMMITTED）では文ごとに別の時点を見るため、読み取りの途中で週の確定や入れ替えがコミットされると、古い currentWeek に新しい週の WeekRecord が混ざる、担当者の一覧と入力済みの数が食い違う、といった不整合な投影が返りうる。MVCC だから止まらない、とだけ書かれていて、一貫した見え方の根拠になっていない。投影の誤りは「未入力の役割を目立たせる」判断に直接使われる | 投影用の読み取りトランザクションに REPEATABLE READ（READ ONLY）を指定すると明記する。または 1 本の SQL で取得する。参加者の投影と履歴の取得にも同じ扱いを適用する。確定と並行して読む試験を NFR3.2 の確かめ方に加える | Resolved (reviewer) |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/nfr-design/security-design.md > NFR6.3 失効、および reliability-design.md > NFR2.3 状態の検査 | 失効の判定は AccessControl が占有の外で行う構成（論理コンポーネント図では AccessControl が DB を直接読み、GameSession とは別）。入れ替えのコミットより前に認可を通った旧担当者の入力が、占有の待ちの後で入れ替えの後に処理されうる。占有の中で行う検査は遷移の表だけで、入力者が今もその役割の担当者であること、token が失効していないことを占有の中で再検査すると書かれていない。結果として、入れ替え後に旧担当者の decision が書かれ、decidedByParticipantId が割当てのない旧参加者になる。NFR6.3 の「以後の旧 token での要求を拒否」と矛盾する | 参加者の入力と確定前の操作で、占有の中で「入力者が現在その役割に就いていること」を再検査する（割当ての有無で判定）。判定の順を security-design.md に明記する。入れ替えと旧担当者の入力が競合する試験（入れ替え後に入力が通らないこと）を NFR6.3 の確かめ方に加える | Resolved (reviewer) |
| R-03 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/nfr-design/reliability-design.md > NFR2.1 入れ替えのトランザクション、NFR2.3 | 入れ替えのトランザクション内で行う事前検査（状態が進行中か一時停止中、旧担当者が今その役割に就いていて未入れ替えであること）が列挙されていない。NFR2.3 の遷移の表は pause、resume、end だけを扱う。検査が占有の外にあると、二重の要求で新しい参加者が 2 人作られうる（BR10.6） | 入れ替えの占有の中の手順の先頭に、状態の検査と旧担当者の検査（409 `state`、409 `conflict`）を書く | Resolved (reviewer) |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/nfr-design/scalability-design.md > 履歴の連番の採番（Q1）、observability-design.md > NFR9.1 | 最終週の確定は weekConfirm と end（system）の 2 件を 1 トランザクションで足す。`next_log_sequence` を 2 回使うこと（同じ占有の中で連続する 2 つの番号）と、`appendLog` が採番と更新を呼び出し 1 回ごとに行うことが明記されていない。連番の欠けと重複の検査（NFR9.2）が、この 2 件の場合をカバーするか不明 | 1 トランザクションで複数件を足すときの採番の順序（weekConfirm の次に end）を書き、連番の検査に最終週の確定の場合を含める | Resolved (reviewer) |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/nfr-design/security-design.md > NFR6.3 判定の順 | 再送の照合が割当てと token の再検査より前にある。入れ替えで失効した旧 token が、以前に成功した識別子を再送した場合は、403 でなく前回の結果が返る設計になっている。返る内容は旧担当者本人の過去の入力の結果だけなので、実害は小さい。ただし意図として書かれていない。 | 失効後の再送で前回の結果を返すのか 403 にするのかを一行で明記する。コード生成の前の確認で足りる。 | New |

> R-01 Reviewer note: performance-design.md の NFR3.2 が `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` を明記し、参加者の投影にも同じ形を適用した。履歴取得は 1 文の読み取りとした。scalability-design.md の NFR4.3 も同じ分離水準に揃っている。週の確定と入れ替えを繰り返しながら読む整合性の試験も追加された。

> R-02 Reviewer note: security-design.md の NFR6.3 と reliability-design.md の NFR2.3 が、占有の中で入力者の現在の割当てと token の失効を再検査し、不一致なら 403 `forbidden` で decision を書かないと定めた。判定の順（認可、占有、再送の照合、状態、再検査、入力の検証）も両文書で一致する。入れ替えと旧担当者の入力を同時に送る競合の試験も追加された。

> R-03 Reviewer note: reliability-design.md の NFR2.1 が、入れ替えの占有内の事前検査を列挙した。内容は、状態が進行中か一時停止中か（409 `state`）、旧担当者がその役割に割り当てられていて `replaced_at` が null か（409 `conflict`）、表示名の検証である。二重の要求で参加者が 2 人作られないことも書かれている。

> R-04 Reviewer note: scalability-design.md が、最終週の確定で weekConfirm を N、end を N+1 として採番する順序を明記した。observability-design.md の NFR9.2 も、連番の検査にこの 2 件の場合を含めている。

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| (none listed for this stage) | n/a | traceability.json の NFR1.1〜NFR9.3 の 25 項目は、7 つの設計文書の記述と対応が取れている。今回の改訂で矛盾は見つからなかった。 |

### Summary

R-01 から R-04 はすべて解消された。改訂で分離水準、占有内の再検査、事前検査、採番順序が文書間で矛盾なく揃い、traceability.json とも整合している。残るのは判定の順に関する Minor 1 件だけで、READY とする。
