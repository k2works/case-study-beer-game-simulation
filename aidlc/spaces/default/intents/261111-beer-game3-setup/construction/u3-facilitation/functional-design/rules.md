# 業務ルール - U3 u3-facilitation

U3（運営操作）の業務ルールです。ストーリー US2.2、US2.3、US2.5、US2.6、US2.7、US2.8、US5.6 の受入条件（AC）を、実行できる規則にしました。規則の番号は `BR{グループ}.{連番}` で、U1（グループ 1〜5）と U2（グループ 6〜8）に続けて、次のグループを使います: 9 ゲームの状態遷移、10 担当者の入れ替え、11 代理入力、12 共同担当と同名の区別、13 操作の履歴、14 進行管理。

出典: `requirements.md`（FR2.4、FR3.2、FR3.3、FR4.5、FR11、FR1.6）、`stories.md`（US2.2、US2.3、US2.5〜US2.8、US5.6）、`entities.md`、`contract-summary.md`、`functional-design-questions.md`（Q1 停止中は代理入力も確定も拒否、Q2 入力者名と値を示す、Q3 常に参加順を併記、Q4 表示名から新規作成、Q5 代理入力は通常の入力と同じ扱い、Q6 作成時の設定を最初の履歴にする、Q7 終了は冪等、Q8 入力値は見せない）。

U1 の BR4.5（入力は進行中の当週だけ）と BR5.11（確定は進行中の当週だけ）は、状態が running でなければ拒否します。そのため、一時停止中（paused）の入力と確定は、U1 の規則のままで拒否されます。U3 は paused を足し、その理由を示します。

## 規則（YAML が正本）

```yaml
rules:
  - id: BR9.1
    statement: 進行役は、進行中のゲームを一時停止できる
    category: policy
    applies_to: [Game.status]
    trigger: 一時停止の要求
    logic: IF 要求が進行役用コードで、status が running THEN status を paused にし、currentWeek と入力済みの値を変えず、履歴（pause）を同じ保存の中で残す。IF status が running でない THEN 拒否する
    violation: 状態が合わないときは拒否する（409 state）。進行役でなければ拒否する（403 forbidden）
    source: FR11.1
  - id: BR9.2
    statement: 進行役は、一時停止中のゲームを再開でき、再開すると進行中に戻って確定の操作ができる
    category: policy
    applies_to: [Game.status]
    trigger: 再開の要求
    logic: IF 要求が進行役用コードで、status が paused THEN status を running に戻し、currentWeek と一時停止前の入力済みの値を保つ。履歴（resume）を同じ保存の中で残す。IF status が paused でない THEN 拒否する
    violation: 状態が合わないときは拒否する（409 state）
    source: FR11.1
  - id: BR9.3
    statement: 一時停止中は、参加者の入力、進行役の代理入力、週の確定をすべて拒否し、一時停止中であることを示す。閲覧、再開、終了、担当者の入れ替えは許す
    category: constraint
    applies_to: [入力の保存, 代理入力, 週の確定, 状態の取得]
    trigger: 一時停止中の入力、代理入力、確定、状態の取得
    logic: IF status が paused かつ操作が入力、代理入力、週の確定 THEN 理由を「一時停止中」として拒否する。ただし判定の順は U1 の BR4.8 に従い、以前に成功した識別子の再送は、状態の検査より先に照合して前回の結果を返す（一時停止中でも終了後でも同じ）。IF 操作が状態の取得 THEN 通常どおり応答する（閲覧は許す）。保存済みの入力は消さない
    violation: 拒否する（409 state、理由に一時停止中を示す）。状態は変わらない
    source: FR11.1
  - id: BR9.4
    statement: 進行役は、進行中または一時停止中のゲームを終了できる。準備中のゲームを進行役は終了できず、準備中からの終了は自動終了（autoEnd、U5）だけが行う
    category: policy
    applies_to: [Game.status, Game.currentWeek, Game.endedAt, Game.endReason]
    trigger: 終了の要求
    logic: IF 要求が進行役用コードで、status が running または paused THEN status を ended にし、endedAt を記録し、endReason を facilitator にして、履歴（end、reason が facilitator）を同じ保存の中で残す。currentWeek は終了した時点の週のまま変えない（途中で終了したときは weekCount より小さい）。その週に確定前の入力があっても、WeekRecord は isConfirmed が false のまま残し、確定したことにしない。IF status が preparing かつ reason が facilitator THEN 拒否する。IF status が preparing かつ reason が autoEnd（U5 の内部呼び出し）THEN 終了にする
    violation: 進行役が準備中を終了しようとしたら拒否する（409 state）。進行役でなければ拒否する（403 forbidden）
    source: FR11.1
  - id: BR9.5
    statement: 終了後は、参加者の入力、代理入力、週の確定、担当者の入れ替え、一時停止、再開をすべて拒否する。閲覧はできる
    category: constraint
    applies_to: [Game.status]
    trigger: 終了後の入力、代理入力、確定、入れ替え、一時停止、再開
    logic: IF status が ended THEN 入力を伴う操作と状態を変える操作を拒否し、「終了済み」を理由に示す。状態の取得は応答する
    violation: 拒否する（409 state）。状態は変わらない
    source: FR11.1
  - id: BR9.6
    statement: 終了の要求は冪等にする。すでに終了していれば、エラーにせず現在の状態を返し、履歴を二重に残さない
    category: constraint
    applies_to: [Game.status, OperationLogEntry]
    trigger: 終了済みのゲームへの終了の要求（再送、または最終週の確定との競合）
    logic: IF status が ended THEN 現在の状態を返し、endReason と endedAt を変えず、履歴も足さない。一時停止と再開は冪等にせず、状態に合わなければ BR9.1、BR9.2 で拒否する
    violation: なし
    source: FR11.1
  - id: BR9.7
    statement: 終了週を確定すると、ゲームは自動で終了する。終了の理由は finalWeek で、週の確定の保存の中で行う
    category: policy
    applies_to: [Game.status, Game.endReason, OperationLogEntry]
    trigger: 週の確定（確定する週が weekCount）
    logic: THEN 週の確定の保存と同じ保存の中で、status を ended にし、endedAt を記録し、endReason を finalWeek にする（終了の遷移そのものは U1 の BR5.10 がすでに行う。U3 は endReason と履歴を足す）。currentWeek は weekCount のまま。履歴は weekConfirm の後に end（reason が finalWeek、actorKind が system）を続けて残す。IF 終了週の確定が失敗した THEN 終了にもならない
    violation: 確定が失敗すれば全体を戻す（U1 の BR5.9、U2 の原子性に従う）
    source: FR11.2
  - id: BR9.8
    statement: 進行役の操作（一時停止、再開、終了、担当者の入れ替え、代理入力、履歴の取得、進行管理）は、進行役用コードを持つ人だけができる
    category: authorization
    applies_to: [一時停止, 再開, 終了, 入れ替え, 代理入力, 履歴の取得, 進行管理]
    trigger: 進行役の操作の要求
    logic: IF 資格情報が進行役用コードでない（参加コード、参加者の token、観察者用コード、無資格） THEN 権限がないとして拒否する。U1 の BR1.5 と同じ判定を通す。終了は reason ごとに認可が違う。reason が facilitator のときだけ進行役用コードを要る。reason が finalWeek（週の確定の保存の中）と autoEnd（U5 の定期処理）は内部の呼び出しで、資格情報の判定を通さない（外部の要求としては受け付けない）
    violation: 拒否する（403 forbidden）。状態は変わらない
    source: FR1.6

  - id: BR10.1
    statement: 進行中と一時停止中は、同じ役割の担当者の入れ替えだけを許す。役割の増減と、他の役割への移動は許さない
    category: constraint
    applies_to: [RoleAssignment]
    trigger: 進行中または一時停止中の割当ての変更の要求
    logic: 進行中と一時停止中の入れ替えの入口は、入れ替え専用の入口（役割ごとの replacement）だけで、「その役割の、いまの担当者 1 人を、新しい 1 人に入れ替える」形しか受け付けない。この入口は他の役割への移動や人数を変える操作を表せない。既存の割当ての入口（PUT assignments、C1）は、status が running または paused のとき、どんな要求でも拒否し、入れ替えには replacement を使うよう案内する。別の役割への移動を求める要求（AC2.6.2）は、この拒否で止まる
    violation: PUT assignments への要求を拒否する（409 state、直し方に replacement の使用を案内）。割当ては変わらない
    source: FR3.2
  - id: BR10.2
    statement: 入れ替えは、進行役が役割と旧担当者と新しい担当者の表示名を指定し、新しい参加者を作ってその役割に就ける。新しい復帰用 token を発行し、平文は応答で一度だけ返す
    category: policy
    applies_to: [Participant, RoleAssignment, ReturnToken]
    trigger: 入れ替えの要求
    logic: IF 状態が running または paused かつ、旧担当者がその役割の担当者 THEN 表示名（1〜40 文字、BR2.5 と同じ）から新しい Participant を作り（joinOrder は次の番号、createdByFacilitator は true）、旧担当者の RoleAssignment を消して新しい参加者の RoleAssignment を足し、旧担当者に replacedAt を設定する。新しい復帰用 token を 128 ビット以上の暗号論的乱数で発行してハッシュで保存し、平文は応答で一度だけ返す。履歴（roleChange、change が replace）を同じ保存の中で残す。token を失った人の復帰も、同じ表示名でこの手順を行う
    violation: 旧担当者がその役割の担当者でない、または表示名が不正なら拒否する（旧担当者は 409 conflict、表示名は 422 validation）。何も変わらない
    source: FR3.2
  - id: BR10.3
    statement: 入れ替えても、役割の在庫、受注残、履歴、確定前の入力は変わらない
    category: constraint
    applies_to: [WeekRecord, PipelineSlot]
    trigger: 入れ替え
    logic: THEN 役割の WeekRecord（確定済みの結果、確定前の decision と decidedBy の項目）と PipelineSlot を変えない。確定前の入力は、旧担当者が入れた値のままで有効に残る
    violation: なし
    source: FR3.2
  - id: BR10.4
    statement: 入れ替えると、旧担当者の復帰用 token は失効し、以後の旧 token での要求を拒否する
    category: authorization
    applies_to: [ReturnToken]
    trigger: 入れ替え、旧 token での要求
    logic: THEN 旧担当者の token に revokedAt を設定する。IF 失効した token での要求 THEN 権限がないとして拒否する。旧 token を持っていた人は、そのゲームの情報を取得できない
    violation: 拒否する（403 forbidden）
    source: FR3.2
  - id: BR10.5
    statement: 入れ替えは、進行中と一時停止中に行える。準備中の割当ては U1 の規則（BR3.2）に従い、終了後は入れ替えられない
    category: constraint
    applies_to: [Game.status, RoleAssignment]
    trigger: 入れ替えの要求
    logic: IF status が running または paused THEN 入れ替える。IF status が preparing THEN 入れ替えではなく U1 の割当ての操作を使う。IF status が ended THEN 拒否する
    violation: 準備中と終了後は拒否する（409 state）
    source: FR3.2
  - id: BR10.6
    statement: 入れ替えの再送で、参加者を二重に作らず、先に発行した token を無効にしない
    category: constraint
    applies_to: [Participant, ReturnToken]
    trigger: 同じ旧担当者を指定する入れ替えの要求が 2 回届く
    logic: IF 旧担当者がすでに入れ替え済み（replacedAt を持つ） THEN 拒否し、すでに入れ替え済みであることを示す。2 回目は何も作らず、1 回目に発行した token を失効させない。新しい token を平文で返し直すことはしない。token を紛失したら、新しい担当者を旧担当者として、もう一度入れ替える
    violation: 拒否する（409 conflict）
    source: FR3.2

  - id: BR11.1
    statement: 進行役は、進行中のゲームの当週について、担当者の有無にかかわらず、どの役割にも代わって入力できる
    category: policy
    applies_to: [WeekRecord.decision]
    trigger: 進行役用コードによる入力の要求
    logic: IF status が running かつ、週が currentWeek かつ、役割が 4 役割のいずれか THEN 値を保存する。値は 0 以上 9999 以下の整数（U1 の BR4.2）。IF 検証に失敗 THEN 拒否する。一時停止中と終了後は BR9.3、BR9.5 で拒否する
    violation: 値の不正は 422 validation、状態の不一致は 409 state
    source: US2.7
  - id: BR11.2
    statement: 代理入力は通常の入力と同じ扱いにする。確定前なら、担当者も進行役も後から上書きでき、最後に保存した値が有効になる。入力した主体を記録する
    category: policy
    applies_to: [WeekRecord.decision, WeekRecord.decidedByKind, WeekRecord.decidedByParticipantId, WeekRecord.decisionRevision]
    trigger: 入力の保存（参加者または進行役）
    logic: THEN decision を上書きし、decidedByKind を participant または facilitator に、decidedByParticipantId を参加者のとき入力した参加者に（進行役のとき null に）、decidedAt を現在時刻に、decisionRevision を 1 増やす。確定後は変えない
    violation: なし
    source: FR7.2
  - id: BR11.3
    statement: 代理入力のたびに、進行役、役割、時刻、値を履歴に残す。参加者の通常の入力は、履歴の 7 種類に含めない
    category: policy
    applies_to: [OperationLogEntry]
    trigger: 進行役用コードによる入力の保存
    logic: THEN 履歴（proxyInput）を、入力の保存と同じ保存の中で残す。actorKind は facilitator、week と role を列に、値を detail に持つ。進行役が同じ役割に複数回入力したら、その回数だけ残す。参加者の通常の入力は、WeekRecord の decidedBy の項目で追える
    violation: 保存に失敗すれば、入力も履歴も残さない
    source: AC2.7.1
  - id: BR11.4
    statement: 代理入力の再送は、通常の入力と同じ識別子の規則で同じ結果にする。進行役の記録と参加者の記録は混ざらない
    category: constraint
    applies_to: [IdempotencyRecord]
    trigger: 進行役用コードによる入力の要求（Idempotency-Key 付き）
    logic: THEN U1 の BR4.7、BR4.8 に従う。requesterId を進行役にして照合する。同じ識別子の再送には前回と同じ結果を返し、履歴を二重に残さない。照合は状態の検査より先に行うため、以前に成功した識別子の再送は、その後に一時停止または終了になっていても前回の結果を返す（新しい識別子の入力は BR9.3、BR9.5 で拒否する）
    violation: 内容が違う再送は 409 conflict
    source: FR7.3

  - id: BR12.1
    statement: 同じ役割を複数人が担当するとき、役割の入力は 1 つで、最後に保存した値だけが有効になる
    category: policy
    applies_to: [WeekRecord.decision, RoleAssignment]
    trigger: 同じ役割の担当者による入力の保存
    logic: THEN WeekRecord の decision は 1 つで、最後に保存した値が有効（BR11.2）。投票も多数決もしない。2 人の入力の順は、ゲーム単位の直列処理（U1 の BR4.6）で決まる
    violation: なし
    source: FR3.3
  - id: BR12.2
    statement: 値が別の担当者によって置き換わったら、同じ役割のほかの担当者の画面に、入力した人の表示名（区別の印つき）と値を示す
    category: policy
    applies_to: [状態の投影, WeekRecord.decisionRevision]
    trigger: 状態の取得（ポーリング）
    logic: THEN 参加者の投影には、自分の役割の当週の decision、decisionRevision、decidedByKind、入力した人のラベル（参加者のとき。進行役のときは「進行役」）を含める。画面は、自分が最後に保存した revision を覚えている間、それと異なる revision を受け取り、入力者が自分でないとき、「<ラベル> が <値> に変更しました」と示す。覚えている revision がない画面（再読み込み、復帰、入れ替え直後の新しい担当者）は、最初に受け取った revision を基準にして通知を出さず、以後 revision が増え、入力者が自分でないときだけ示す。他の役割の担当者には含めない（U1 の BR4.1）
    violation: なし
    source: AC2.2.1
  - id: BR12.3
    statement: 1 つの役割に就ける人数は 4 人まで。5 人目の割当ては拒否する
    category: constraint
    applies_to: [RoleAssignment]
    trigger: 準備中の割当てまたは付け替え
    logic: IF その役割にすでに 4 人が就いている THEN 5 人目の割当てを拒否し、定員を案内する。定員の判定の実装は U1 の BR3.2 が持ち、U3 は新しい判定を足さない。U3 が持つのは、AC2.2.2 の受入試験（4 人の役割への 5 人目が拒否される）と、入れ替えが人数を変えないため定員を超えないことの確認である
    violation: 拒否する（409 conflict）。割当ては変わらない
    source: FR3.3
  - id: BR12.4
    statement: 同じ表示名の参加者は、拒否せず、内部では別の参加者にし、画面では常に参加順を併記して区別する
    category: policy
    applies_to: [Participant.displayName, Participant.joinOrder]
    trigger: 参加者の表示（ロビー、進行管理、共同担当の通知、履歴）
    logic: THEN 参加者のラベルは「表示名 #参加順」とし、joinOrder は参加者ごとに別の値（ゲーム内で一意）にする。同名の参加者が後から参加しても、すでに表示されているラベルは変わらない。内部の識別は participantId で行い、表示名では行わない
    violation: なし
    source: FR2.4

  - id: BR13.1
    statement: 設定、役割変更、代理入力、週確定、一時停止、再開、終了の 7 種類の操作それぞれに、誰が、いつ、何をしたかを履歴に残す
    category: policy
    applies_to: [OperationLogEntry]
    trigger: 7 種類の操作のいずれか
    logic: THEN 操作と同じ保存の中で OperationLogEntry を 1 件足す。kind は setting、roleChange、proxyInput、weekConfirm、pause、resume、end のいずれか。actorKind、occurredAt（注入した時計）、detail を持つ。操作が失敗した、または保存が失敗した場合は、操作も履歴も残さない
    violation: 履歴を残せなければ操作を失敗させる（部分更新を残さない）
    source: US5.6
  - id: BR13.2
    statement: 履歴は追記だけで、変更も削除もしない。順序は sequence で決める
    category: constraint
    applies_to: [OperationLogEntry.sequence]
    trigger: 履歴の追記、履歴の取得
    logic: THEN sequence をゲーム内で 1 から連番にして足す。既存の行を更新も削除もしない。取得は sequence の昇順で返す
    violation: なし
    source: US5.6
  - id: BR13.3
    statement: 準備中の役割の割当てと付け替えも、役割変更の履歴に残す
    category: policy
    applies_to: [OperationLogEntry]
    trigger: 準備中の割当て、付け替え（U1 の BR3.2）
    logic: THEN roleChange を残す。change は、初めての割当てなら assign、別の役割への付け替えなら reassign。進行中と一時停止中の入れ替えは replace（BR10.2）。detail に参加者のラベル、元と先の役割、そのときのゲームの状態を持つ
    violation: 履歴を残せなければ割当ても失敗させる
    source: US5.6
  - id: BR13.4
    statement: ゲームの作成の保存の中で、作成時の設定を「設定」の履歴の最初の 1 件として残す。作成後に設定を変える入口は足さない
    category: policy
    applies_to: [OperationLogEntry, GameSettings]
    trigger: ゲームの作成
    logic: THEN kind が setting の履歴を、sequence 1 として足す。detail には週数、初期在庫、初期パイプライン数量、在庫単価、受注残単価、種別（キット準拠かカスタムか）、需要系列の長さと「仮の既定か」を持つ。需要系列の値そのものは履歴に持たない。設定は作成時に固定され、作成後は変わらない（U1）
    violation: 履歴を残せなければゲームも作らない
    source: US5.6
  - id: BR13.5
    statement: 履歴は進行役だけが取得でき、参加者と観察者には返さない
    category: authorization
    applies_to: [履歴の取得]
    trigger: 履歴の取得の要求
    logic: IF 資格情報が進行役用コード THEN sequence の昇順で全件を返す。IF それ以外 THEN 権限がないとして拒否する
    violation: 拒否する（403 forbidden）
    source: US5.6
  - id: BR13.6
    statement: 履歴に、復帰用 token、進行役用コード、参加コード、観察者用コードの平文を残さない
    category: constraint
    applies_to: [OperationLogEntry.detail]
    trigger: 履歴の追記
    logic: THEN detail には参加者のラベルと識別子だけを持ち、資格情報の値は含めない。入れ替えの履歴は、新しい token の発行を事実として示すだけで、値を持たない
    violation: なし
    source: NFR（秘匿情報の扱い、components.md の AccessControl の責務）

  - id: BR14.1
    statement: 進行管理では、4 役割の入力完了状況と、各役割の現在の状態を、進行役に示す
    category: policy
    applies_to: [進行役の投影]
    trigger: 進行役用コードによる状態の取得
    logic: THEN 進行役の投影に次を含める。ゲームの状態（status）、現在の週、4 役割それぞれの入力完了状況（入力済みか未入力か）、各役割の現在の状態（在庫、受注残、当週の受注、当週の入荷）、各役割の担当者の一覧（ラベルと役割）、入力済みの数。未入力の役割は、画面で目立つように区別できる印を返す。一時停止中と終了後も取得できる
    violation: なし
    source: FR4.5
  - id: BR14.2
    statement: 進行管理は、入力済みの値そのものを示さない。入力完了状況は「入力済み」「未入力」だけにする
    category: constraint
    applies_to: [進行役の投影]
    trigger: 進行役の投影の作成
    logic: THEN 各役割の当週の decision の値は投影に含めない。値は代理入力の履歴（自分が入れた値）にだけ残る。ほかの参加者の入力値を、進行役が週の確定の前に知ることはない
    violation: なし
    source: FR4.5
  - id: BR14.3
    statement: 進行管理は進行役用コードを持つ人だけが取得できる。参加者の画面から進行管理の URL を直接要求しても、拒否する
    category: authorization
    applies_to: [進行役の投影]
    trigger: 進行管理の取得の要求
    logic: IF 資格情報が進行役用コードでない（参加者の token、観察者用コード、無資格） THEN 権限がないとして拒否する。応答には進行役の投影の項目を含めない
    violation: 拒否する（403 forbidden）
    source: FR4.5
```

## 規則の概要

| グループ | 規則 | 内容 |
| :--- | :--- | :--- |
| 9 ゲームの状態遷移 | BR9.1〜BR9.8 | 一時停止、再開、停止中の拒否、進行役の終了、終了後の拒否、終了の冪等、終了週の自動終了、進行役の権限 |
| 10 担当者の入れ替え | BR10.1〜BR10.6 | 同じ役割だけ、新規作成と token の再発行、役割の状態は不変、旧 token の失効、状態の条件、再送の安全 |
| 11 代理入力 | BR11.1〜BR11.4 | 担当者の有無によらず可、通常の入力と同じ扱いと主体の記録、履歴、再送 |
| 12 共同担当と同名 | BR12.1〜BR12.4 | 後勝ち、置き換わりの表示、定員 4 人、常に参加順を併記 |
| 13 操作の履歴 | BR13.1〜BR13.6 | 7 種類、追記のみ、準備中の割当て、作成時の設定、進行役だけ取得、資格情報を含めない |
| 14 進行管理 | BR14.1〜BR14.3 | 入力完了状況と現在の状態、値は示さない、進行役だけ取得 |
