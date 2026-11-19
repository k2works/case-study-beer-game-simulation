## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-11T09:43:19Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/domain-design/components.md > component GameSession behaviour、および decisions.md > ADR-003 Consequences | ゲーム全体を 1 つの集約にし、「確定前の入力は入力した時点で保存する」としている。4 役割が同じ週に同時に入力するのは通常の動きで、例外ではない。それなのに ADR-003 は競合を「1 ゲームの中に限られるため許容する」とだけ書き、同時更新の制御（楽観的な版管理か、行の排他か）を定めていない。入力の保存が集約全体の読み書きなら、同時に入力した役割の更新が失われるか、再試行が多発する。AC2.4.2（確定の同時要求）、AC2.4.3（入力の二重送信）、AC5.3.1（入力確定の p95 が 1 秒以内）を満たす根拠が部品の設計から読み取れない。また ADR-003 は保存の大きさが「50 週で上限が決まる」と書くが、OperationLogEntry は上限がなく、代理入力や再試行で増える。 | 同時更新の制御方式（例: 集約の版番号による楽観的ロック、または入力だけを集約の更新単位から切り出す）を ADR-003 に決めて書く。入力の保存が他の役割の入力を上書きしないことと、確定の冪等キー（ゲームと週）を明記する。履歴の大きさの見積りも加える。 | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/domain-design/components.md > component Retention depends_on、GameSession behaviour、AccessControl entities（AccessCode、ReturnToken） | AccessCode と ReturnToken は AccessControl の保存に置かれ、Game と Participant を参照する。しかし 3 つの整合性が部品間で保証されていない。(1) AC5.1.1 は削除時に「参加コードは無効になる」と求めるが、Retention は GameSession にしか依存せず、AccessControl への経路がない。ゲームを削除すると AccessCode と ReturnToken が残る。(2) AC2.6.1 は担当者の入れ替え時に以前の token を無効にすると求めるが、入れ替えを行う GameSession は AccessControl を呼べない（呼ぶと循環する）。(3) 参加時の Participant の作成（GameSession）と ReturnToken の発行（AccessControl）が別の保存で、片方だけ成功する可能性がある。 | 次のどちらかを決めて components.md に反映する。(a) token の有効性を要求ごとに RoleAssignment と突き合わせて判定する（入れ替えで自動的に無効になる）と書く。(b) 失効・削除を依頼する向きの依存を循環なしに定義する（例: Retention と GameSession から AccessControl へ、イベントまたは明示的な呼び出し）。参加時の二つの保存の順序と失敗時の扱いも書く。 | New |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/domain-design/decisions.md > ADR-002 Consequences、components.md > component GameSession behaviour と AccessControl behaviour | FR4 の情報制約の守りは、「GameSession を直接公開しない」という規則に頼っている。ADR-002 自身が「構造で強制する必要がある」と書くが、構造での強制方法は書かれていない。GameSession の依存元は AccessControl、Reporting、Retention の 3 つで、入口の層が GameSession を直接呼ぶことを防ぐ仕組みがない。Reporting が終了前のゲームを読まない保証も Reporting の責務にない。さらに AccessControl は、コードと token の発行、権限の判定、試行回数の制限に加えて、GameSession の内部の形を知って役割別の投影とチーム全体の集計値を作る。この集計値は「役割別の非公開情報を逆算できない」ことが条件（AC2.9.1）だが、その判定規則はどこにも定義されていない。 | 公開しない規則を構造として定める（例: GameSession に「役割 R の視点」の問い合わせだけを公開し、全役割の状態の読み取りを入口の層から見えなくする。または投影の部品を AccessControl から分ける）。観察者の集計値に含める項目を列挙し、逆算できないことの条件を書く。Reporting の読み取りは終了したゲームに限ると明記する。 | New |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/domain-design/components.md > component AccessControl entities と behaviour | ReturnToken は Participant だけを対象にする。進行役と観察者が、参加後の要求で何を提示するか（コードそのものを毎回使うのか）が書かれていない。進行役の再入場、観察者の入り方（ADR-005）、進行役用コードが漏れたときの失効と再発行の経路が、部品の設計に出ていない。 | 進行役・観察者の再入場の方法と、AccessCode の失効・再発行を AccessControl の責務と behaviour に書く。 | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/domain-design/components.md > component Retention behaviour、component AccessControl behaviour | 30 日（自動終了）、token の有効期間、試行回数の上限は、stories.md では仮の値（US3.2、US5.1、US5.4）だが、components.md の behaviour には確定した事実のように書かれている（Retention は「最後の操作から 30 日」）。また「最後の操作」の時刻を保持する属性（Game の lastActivityAt など）が実体にない。 | 仮の値には「仮」と明記して NFR の確定を参照させる。自動終了の判定に使う最終操作の時刻を、Game の属性か OperationLogEntry からの導出かのどちらかで決める。 | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/domain-design/components.md > entity WeekRecord と RoleAssignment、traceability.json > US1.6、US2.2 | 次の 2 点で対応が薄い。(1) AC2.2.1 は共同担当の後勝ちで、置き換わったことを相手に示すと求めるが、WeekRecord.decision に入力者や更新の順序を表す属性がない。(2) AC1.6.4 は出力に「カスタム」の区別が残ることを求めるが、US1.6 の対応先に Reporting が入っていない。 | WeekRecord に最後に入力した参加者と更新時刻の属性を足す。US1.6 の対応先に Reporting を加える。 | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| aidlc engine sensor-traceability | 未実行（必要な引数が不明） | 目で突き合わせた。upstream_ids の 26 件は stories.md の US1.1〜US5.7 と一致し、N/A の 2 件（US5.5、US5.7）は理由が妥当。 |
| components.md の well-formedness（目視） | 問題なし | 部品名は一意。depends_on と dependents は対称（GameSession、SimulationEngine、AccessControl、Reporting、Retention）。自己依存と循環はない。実体 11 件はそれぞれちょうど 1 部品が所有し、references.entity の所有部品は宣言と一致する。インフラ（PostgreSQL、Clock、RandomSource、Scheduler）は external_dependencies にある。 |

### Summary

構造の基本（循環なし、対称な依存、所有の一意性、ADR の 4 項目と代替案）は整っている。一方で、1 集約への同時入力の制御、AccessControl と GameSession の間の失効と削除の整合、情報制約を構造で守る方法の 3 点が未決定のまま。実装者が推測せずに作るには、決定が要る。
