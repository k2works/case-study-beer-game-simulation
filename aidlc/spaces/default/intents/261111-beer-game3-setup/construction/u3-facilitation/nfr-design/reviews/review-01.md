## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-12T07:40:26Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/nfr-design/performance-design.md > NFR3.2 進行管理の投影、および scalability-design.md > NFR4.3 | 進行管理の投影は「読み取り専用の短いトランザクション」で games、WeekRecord、PipelineSlot、Participant、RoleAssignment を複数回に分けて読み、占有しないとある。分離水準の指定がない。PostgreSQL の既定（READ COMMITTED）では文ごとに別の時点を見るため、読み取りの途中で週の確定や入れ替えがコミットされると、古い currentWeek に新しい週の WeekRecord が混ざる、担当者の一覧と入力済みの数が食い違う、といった不整合な投影が返りうる。MVCC だから止まらない、とだけ書かれていて、一貫した見え方の根拠になっていない。投影の誤りは「未入力の役割を目立たせる」判断に直接使われる | 投影用の読み取りトランザクションに REPEATABLE READ（READ ONLY）を指定すると明記する。または 1 本の SQL で取得する。参加者の投影と履歴の取得にも同じ扱いを適用する。確定と並行して読む試験を NFR3.2 の確かめ方に加える | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/nfr-design/security-design.md > NFR6.3 失効、および reliability-design.md > NFR2.3 状態の検査 | 失効の判定は AccessControl が占有の外で行う構成（論理コンポーネント図では AccessControl が DB を直接読み、GameSession とは別）。入れ替えのコミットより前に認可を通った旧担当者の入力が、占有の待ちの後で入れ替えの後に処理されうる。占有の中で行う検査は遷移の表だけで、入力者が今もその役割の担当者であること、token が失効していないことを占有の中で再検査すると書かれていない。結果として、入れ替え後に旧担当者の decision が書かれ、decidedByParticipantId が割当てのない旧参加者になる。NFR6.3 の「以後の旧 token での要求を拒否」と矛盾する | 参加者の入力と確定前の操作で、占有の中で「入力者が現在その役割に就いていること」を再検査する（割当ての有無で判定）。判定の順を security-design.md に明記する。入れ替えと旧担当者の入力が競合する試験（入れ替え後に入力が通らないこと）を NFR6.3 の確かめ方に加える | New |
| R-03 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/nfr-design/reliability-design.md > NFR2.1 入れ替えのトランザクション、NFR2.3 | 入れ替えのトランザクション内で行う事前検査（状態が進行中か一時停止中、旧担当者が今その役割に就いていて未入れ替えであること）が列挙されていない。NFR2.3 の遷移の表は pause、resume、end だけを扱う。検査が占有の外にあると、二重の要求で新しい参加者が 2 人作られうる（BR10.6） | 入れ替えの占有の中の手順の先頭に、状態の検査と旧担当者の検査（409 `state`、409 `conflict`）を書く | New |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/nfr-design/scalability-design.md > 履歴の連番の採番（Q1）、observability-design.md > NFR9.1 | 最終週の確定は weekConfirm と end（system）の 2 件を 1 トランザクションで足す。`next_log_sequence` を 2 回使うこと（同じ占有の中で連続する 2 つの番号）と、`appendLog` が採番と更新を呼び出し 1 回ごとに行うことが明記されていない。連番の欠けと重複の検査（NFR9.2）が、この 2 件の場合をカバーするか不明 | 1 トランザクションで複数件を足すときの採番の順序（weekConfirm の次に end）を書き、連番の検査に最終週の確定の場合を含める | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| (none listed for this stage) | N/A | traceability.json の NFR25 件（NFR1.1、2.1-2.3、3.1-3.4、4.1-4.4、5.1-5.2、6.1-6.7、7.1、9.1-9.3）は上流の定義と一致し、対象のファイルと節に実際に記述がある。網羅の欠落はない |

### Summary

トレーサビリティは網羅され、reason の固定、token の平文の扱い、投影の型による秘匿、追記専用の担保、連番の採番は整合している。ただし、占有をしない投影の一貫性（分離水準の未指定）と、入れ替えと旧担当者の入力の競合（占有の中での再検査がない）の 2 点は、実装者が推測で埋めると誤りになるため、修正してから進めるべきである。
