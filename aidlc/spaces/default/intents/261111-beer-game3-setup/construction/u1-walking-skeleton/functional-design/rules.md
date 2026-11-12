# 業務ルール - U1 u1-walking-skeleton

U1（薄い一通り）の業務ルールです。ストーリー US1.1〜US1.5 の受入条件（AC）を、実行できる規則にしました。規則の番号は `BR{グループ}.{連番}` で、グループは次のとおりです: 1 ゲーム作成、2 参加、3 割当てと開始、4 入力と見せ方、5 週の確定。

出典: `requirements.md`（FR1〜FR10）、`stories.md`（US1.1〜US1.5）、`entities.md`、`contract-summary.md`、`functional-design-questions.md`（Q1 上限 9999、Q2 仮の需要系列、Q4 ゲーム単位の直列処理）。

## 規則（YAML が正本）

```yaml
rules:
  - id: BR1.1
    statement: 週数は 1 以上 50 以下の整数
    category: validation
    applies_to: [GameSettings.weekCount, Game.weekCount]
    trigger: ゲームの作成
    logic: IF 週数が整数でない、または 1 未満、または 50 超 THEN 範囲外として拒否し、1〜50 を案内する
    violation: 拒否する（422 validation）。入力済みの他の項目は残す
    source: FR1.1
  - id: BR1.2
    statement: 需要系列の長さは週数と同じで、各値は 0 以上の整数
    category: validation
    applies_to: [DemandSeries.values]
    trigger: ゲームの作成（需要系列を指定したとき）
    logic: IF 要素数が週数と異なる、または非負の整数でない値がある THEN 長さ不一致または値の不正として拒否する
    violation: 拒否する（422 validation）
    source: FR1.2
  - id: BR1.3
    statement: 初期在庫と初期パイプライン数量は 0 以上の整数。遅延の週数は設定項目にしない
    category: validation
    applies_to: [GameSettings.initialInventory, GameSettings.initialPipelineQuantity]
    trigger: ゲームの作成
    logic: IF 負数または整数でない THEN 非負の整数を案内して拒否する。設定の入力には遅延の週数の項目を持たない
    violation: 拒否する（422 validation）
    source: FR1.4
  - id: BR1.4
    statement: 設定が正しければゲームを準備中で作り、参加コード、進行役用コード、観察者用コードを発行する
    category: policy
    applies_to: [Game, AccessCode]
    trigger: ゲームの作成（設定が妥当）
    logic: THEN 参加コードは 8 文字以上の英数字、進行役用コードと観察者用コードは暗号論的乱数による 128 ビット以上で発行する。照合のためにハッシュを保存する。参加コードと観察者用コードは、進行役が共有するために再表示できる形（暗号化）でも保存し、進行役が何度でも見られる。進行役用コードはハッシュだけで、作成の応答でだけ平文を返し、紛失しても再表示も再発行もしない
    violation: 発行に失敗したらゲームも作らない（同じ保存の中で行う）
    source: FR1.6
  - id: BR1.5
    statement: 進行役の操作は進行役用コードを持つ人だけができる
    category: authorization
    applies_to: [ゲームの開始、役割の割当て、週の確定]
    trigger: 進行役の操作の要求
    logic: IF 資格情報が進行役用コードでない（参加コード、参加者の token、無資格） THEN 権限がないとして拒否する
    violation: 拒否する（403 forbidden）。状態は変わらない
    source: FR1.6
  - id: BR1.6
    statement: 需要系列が指定されなければ、仮の既定（週 1〜4 は 4、週 5 以降は 8）を週数の長さで入れる
    category: policy
    applies_to: [DemandSeries]
    trigger: ゲームの作成（需要系列の指定なし）
    logic: THEN isProvisionalDefault を true にして仮の系列を入れる
    violation: なし
    source: FR1.3
  - id: BR1.7
    statement: U1 では、作成したゲームの種別は常に「カスタム」
    category: policy
    applies_to: [Game.setupKind]
    trigger: ゲームの作成
    logic: THEN setupKind を custom にする。キット準拠の判定は U2 が足す
    violation: なし
    source: FR1.7
  - id: BR1.8
    statement: 金額は整数の最小単位（セント）で扱い、浮動小数点を使わない
    category: constraint
    applies_to: [GameSettings.inventoryUnitCost, GameSettings.backlogUnitCost, WeekRecord.weeklyCost, WeekRecord.cumulativeCost]
    trigger: 費用の保存と計算
    logic: THEN 在庫単価の既定は 50、受注残単価の既定は 100
    violation: なし
    source: FR10.2
  - id: BR2.1
    statement: 準備中のゲームの有効な参加コードと表示名で、参加できる
    category: policy
    applies_to: [Participant]
    trigger: 参加の要求
    logic: IF 参加コードが有効で、ゲームが準備中 THEN 参加者を追加し、参加順の番号を付け、ロビーの一覧に表示名を加える
    violation: なし
    source: FR2.1
  - id: BR2.2
    statement: 終了済みのゲームのコードでは、参加できない
    category: policy
    applies_to: [Participant]
    trigger: 参加の要求
    logic: IF ゲームが終了済み THEN 「終了済み」という理由で拒否する
    violation: 拒否する（409 state）
    source: FR2.2
  - id: BR2.3
    statement: 進行中のゲームのコードでは、新しい人は参加できない
    category: policy
    applies_to: [Participant]
    trigger: 参加の要求
    logic: IF ゲームが進行中 THEN 「進行中のため参加できない」という理由で拒否する
    violation: 拒否する（409 state）
    source: FR2.2
  - id: BR2.4
    statement: 無効なコードでは、参加できない
    category: validation
    applies_to: [Participant]
    trigger: 参加の要求
    logic: IF コードが存在しない、または失効している THEN 理由を示して拒否する
    violation: 拒否する（403 forbidden）。試行回数の制限は U4 が足す
    source: FR2.2
  - id: BR2.5
    statement: 表示名は 1〜40 文字。同じ表示名の参加者を許す
    category: validation
    applies_to: [Participant.displayName]
    trigger: 参加の要求
    logic: IF 空、または 40 文字を超える THEN 拒否する。同名は拒否しない
    violation: 拒否する（422 validation）
    source: FR2.1
  - id: BR2.6
    statement: 参加時に参加者を特定する token を発行し、以後の参加者の要求はその token で判定する
    category: authorization
    applies_to: [ReturnToken, 参加者の要求]
    trigger: 参加の成功、参加者の要求
    logic: THEN token は 128 ビット以上の暗号論的乱数で発行し、ハッシュで保存する。要求ごとに token から参加者と役割を特定する
    violation: token が無効なら拒否する（403 forbidden）
    source: FR2.3
  - id: BR3.1
    statement: 4 つの役割すべてに 1 人以上が就いていなければ、開始できない
    category: constraint
    applies_to: [Game.status]
    trigger: ゲームの開始
    logic: IF 未割当ての役割がある THEN 開始を拒否し、未割当ての役割を示す
    violation: 拒否する（409 state。missingRoles に役割を示す）
    source: FR3.1
  - id: BR3.2
    statement: 準備中は、参加者の役割を自由に割り当て、別の役割へ移せる。1 人の参加者は最大 1 つの役割に就き、1 つの役割の定員は 4 人
    category: policy
    applies_to: [RoleAssignment]
    trigger: 役割の割当て（準備中）
    logic: IF ゲームが準備中 THEN 割当てを追加または付け替える。IF その役割がすでに 4 人 THEN 拒否する。IF 準備中でない THEN 拒否する（担当者の入れ替えは U3）
    violation: 拒否する（409 state）
    source: FR3.2
  - id: BR3.3
    statement: 開始すると、ゲームは進行中になり、第 1 週が始まり、初期状態が固定される
    category: policy
    applies_to: [Game, PipelineSlot, WeekRecord]
    trigger: ゲームの開始（4 役割が揃っている）
    logic: THEN status を running、currentWeek を 1 にする。第 1 週の計算が使う「前週末」の値を、設定から決める（前週末在庫は初期在庫、前週末受注残は 0、前週までの累積費用は 0）。配送、注文、生産の各枠（remainingWeeks 1 と 2）に初期パイプライン数量を入れる。第 1 週の WeekRecord を役割ごとに作る（確定前なので decision 以外は null）
    violation: 途中で失敗したら、開始前の状態のまま（1 回の保存で行う）
    source: FR3.1
  - id: BR4.1
    statement: 参加者には自分の役割の情報だけを返し、他役割の在庫、受注残、意思決定値、将来の需要は応答に含めない
    category: authorization
    applies_to: [状態の取得、入力の要求]
    trigger: 参加者の要求
    logic: IF 要求が他役割の情報の取得または入力 THEN 拒否し、値は返さない。応答は参加者の役割の投影だけから作る
    violation: 拒否する（403 forbidden）
    source: FR4.1
  - id: BR4.2
    statement: 意思決定の入力は 0 以上 9999 以下の整数
    category: validation
    applies_to: [WeekRecord.decision]
    trigger: 入力の要求
    logic: IF 小数、負数、空欄、数値でない、または 9999 を超える THEN 拒否し、理由と上限を案内する
    violation: 拒否する（422 validation）。入力済みの他の値は残る
    source: FR7.1
  - id: BR4.3
    statement: 0 は有効な入力として受け付ける
    category: validation
    applies_to: [WeekRecord.decision]
    trigger: 入力の要求
    logic: IF 0 THEN 受け付ける
    violation: なし
    source: FR7.1
  - id: BR4.4
    statement: 週の確定前は、入力を何度でも変更でき、最後の値が有効になる。入力は入力した時点で保存する
    category: policy
    applies_to: [WeekRecord.decision]
    trigger: 入力の要求（当週が未確定）
    logic: THEN 役割の当週の decision を上書きして保存する
    violation: なし
    source: FR7.2
  - id: BR4.5
    statement: 入力は、進行中のゲームの当週に対してだけ受け付ける。1 つの役割に入力できる値は 1 つ
    category: constraint
    applies_to: [WeekRecord]
    trigger: 入力の要求
    logic: IF status が running でない、または週が currentWeek でない THEN 拒否する
    violation: 拒否する（409 state）
    source: FR7.1
  - id: BR4.6
    statement: 同じゲームへの書き込みは、ゲーム単位で直列に処理する
    category: constraint
    applies_to: [Game]
    trigger: 入力、割当て、開始、確定の要求
    logic: THEN 同じゲームへの書き込みを、1 つずつ順に処理する。別のゲームは影響を受けない。利用者に衝突は見せない
    violation: 順番を待てなかったときは unavailable（HTTP 503）で返し、画面が取り直す
    source: FR9.1
  - id: BR4.7
    statement: 入力と週確定の再送は、利用者が付けた識別子で同じ結果にする
    category: constraint
    applies_to: [IdempotencyRecord]
    trigger: 入力または週確定の要求
    logic: IF 同じゲーム、同じ操作、同じ呼び出した人、同じ識別子で、同じ内容 THEN 前回の結果を返し、重複して処理しない。IF 同じ組で内容が違う THEN 409 の conflict で拒否する。別の人の記録の結果は返さない
    violation: 拒否する（409 conflict）
    source: FR7.3
  - id: BR4.8
    statement: 入力と週の確定の要求は、認可、再送の照合、状態の検査、入力の検証の順に判定する
    category: constraint
    applies_to: [入力の要求、週の確定の要求]
    trigger: 入力または週の確定の要求
    logic: THEN 先に呼び出した人の権限を確かめ（BR1.5、BR4.1）、次に再送かどうかを照合し（BR4.7）、再送なら前回の結果を返して終える。再送でなければ、状態を検査し（BR4.5、BR5.11）、入力の内容を検証して（BR4.2）から処理する。確定後に遅れて届いた入力の再送も、前回の結果を返す
    violation: 判定のどの段階で失敗しても、状態は変わらない
    source: FR9.1
  - id: BR5.1
    statement: 4 役割の入力が揃っていなければ、週を確定できない
    category: constraint
    applies_to: [Game.currentWeek]
    trigger: 週の確定
    logic: IF 当週の decision が 1 つでも未入力 THEN 確定を拒否し、未入力の役割を示す
    violation: 拒否する（409 state。missingRoles に役割を示す）
    source: FR5.1
  - id: BR5.2
    statement: 入荷数の確認と受注数の確認は表示のみで、確定の条件にしない
    category: policy
    applies_to: [週の確定]
    trigger: 週の確定
    logic: IF 4 役割の入力が揃っている THEN 確認の操作がなくても確定できる
    violation: なし
    source: FR5.1
  - id: BR5.3
    statement: 利用可能量、充足対象、出荷、週末在庫、週末受注残を次の式で計算する
    category: calculation
    applies_to: [WeekRecord]
    trigger: 週の確定
    logic: 利用可能量 = 前週末在庫 + 当週入荷。充足対象 = 前週末受注残 + 当週受注。出荷 = 利用可能量と充足対象の小さい方。週末在庫 = max(0, 利用可能量 - 充足対象)。週末受注残 = max(0, 充足対象 - 利用可能量)。負の値は保存しない。第 1 週の前週末在庫は初期在庫、前週末受注残は 0（BR3.3）。第 2 週以降は、前の週の確定済みの記録の週末在庫と週末受注残を使う
    violation: なし
    source: FR6.1
  - id: BR5.4
    statement: 配送は 2 週の遅延で届く。第 t 週の出荷は、第 t+2 週の入荷になる
    category: calculation
    applies_to: [PipelineSlot.delivery]
    trigger: 週の確定
    logic: THEN 当週の入荷は、配送の枠のうち remainingWeeks 1 の数量。確定のたびに、その枠を消費し、remainingWeeks 2 の枠を 1 に前進させ、当週の出荷を新しい remainingWeeks 2 の枠として入れる
    violation: なし
    source: FR8.1
  - id: BR5.5
    statement: 注文情報は 2 週の遅延で届く。第 t 週の発注は、第 t+2 週の上流の受注になる
    category: calculation
    applies_to: [PipelineSlot.order]
    trigger: 週の確定
    logic: THEN 当週の受注は、注文の枠のうち remainingWeeks 1 の数量。確定のたびに、その枠を消費し、remainingWeeks 2 の枠を 1 に前進させ、当週の発注数を上流の新しい remainingWeeks 2 の枠として入れる。小売店の受注は顧客需要で、枠を持たない
    violation: なし
    source: FR8.1
  - id: BR5.6
    statement: 工場は、一次卸からの注文を受注として扱い、生産要請を 2 段階の生産の枠へ入れる。全役割が同じステップ番号で進む
    category: calculation
    applies_to: [factory]
    trigger: 週の確定
    logic: THEN 工場の受注は注文の枠（remainingWeeks 1）から取る。工場の生産要請数は生産の枠の remainingWeeks 2 として入れ、2 週後に工場の入荷（生産の枠の remainingWeeks 1）になる。工場に配送の枠はない
    violation: なし
    source: FR5.2
  - id: BR5.7
    statement: すでに確定した週の確定が再び来ても、状態は変わらず、前回と同じ結果を返す
    category: constraint
    applies_to: [Game, WeekRecord]
    trigger: 週の確定（同じ週、同じ識別子）
    logic: IF 当週が確定済み、または識別子の記録がある THEN 状態を変えず、前回の結果を返す
    violation: なし
    source: FR9.1
  - id: BR5.8
    statement: 週次費用は 週末在庫 × 在庫単価 + 週末受注残 × 受注残単価。累積費用に加える。チーム費用は 4 役割の合計
    category: calculation
    applies_to: [WeekRecord.weeklyCost, WeekRecord.cumulativeCost]
    trigger: 週の確定
    logic: THEN 整数の最小単位で計算する。第 1 週の前週までの累積費用は 0（BR3.3）。キット準拠の単価では、週末在庫 8、週末受注残 4 のとき 800（$8.00）
    violation: なし
    source: FR10.1
  - id: BR5.9
    statement: 週の確定は、4 役割の記録、枠の前進、週の進行を、1 回の保存で行う
    category: constraint
    applies_to: [Game]
    trigger: 週の確定
    logic: THEN 途中で失敗したら、確定前の状態のままにする。部分更新を残さない。保存のたびに版を 1 増やす。直列に処理する場合（BR4.6）も、版の検査は安全装置として残し、版が食い違う保存は拒否する
    violation: 失敗として返す（500 internal）。確定前の状態のまま
    source: FR9.2
  - id: BR5.10
    statement: 最終週を確定すると、ゲームは終了になる（最小の遷移）
    category: policy
    applies_to: [Game.status]
    trigger: 週の確定（週が weekCount）
    logic: THEN status を ended にして endedAt を入れる。currentWeek は weekCount のままにする。一時停止、再開、進行役による終了は U3
    violation: なし
    source: FR11.2
  - id: BR5.11
    statement: 週の確定は、進行中のゲームの当週に対してだけ受け付ける
    category: constraint
    applies_to: [Game.status, Game.currentWeek]
    trigger: 週の確定（再送でないとき。BR4.8）
    logic: IF status が running でない、または要求の週が currentWeek と違う（未来の週、確定済みの過去の週） THEN 拒否する
    violation: 拒否する（409 state）。状態は変わらない
    source: FR9.1
```

## 規則の概要

| グループ | 規則 | 内容 |
| :--- | :--- | :--- |
| 1 ゲーム作成 | BR1.1〜BR1.8 | 週数、需要系列、初期値の検証。コードの発行。進行役の権限。仮の既定。金額の単位 |
| 2 参加 | BR2.1〜BR2.6 | 参加の可否、表示名、参加者の token |
| 3 割当てと開始 | BR3.1〜BR3.3 | 役割の割当て、開始の条件、初期状態 |
| 4 入力と見せ方 | BR4.1〜BR4.8 | 役割別の見せ方、入力の検証、上書き、直列処理、再送、判定の順 |
| 5 週の確定 | BR5.1〜BR5.11 | 入力の揃い、計算、遅延、冪等性、費用、原子性、終了、事前条件 |

## 上流の資料

`requirements.md`、`stories.md`、`entities.md`、`contract-summary.md`、`functional-design-questions.md`
