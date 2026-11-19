# 業務ルール - U2 u2-weekly-rules

U2（週次ルールの完成）の規則です。U1 の BR1.1〜BR5.11 は変えず、足します。番号は U1 と重ならないよう、グループ 6〜8 を使います: 6 キット準拠とカスタムの区別、7 確定の原子性と冪等性の強化、8 再現性と設定の上限。

出典: `requirements.md`（FR1.5、FR1.7、FR9、NFR1）、`stories.md`（US1.6、US2.4、US5.2）、U1 の `rules.md`、`functional-design-questions.md`（Q1〜Q3）。

## 規則（YAML が正本）

```yaml
rules:
  - id: BR6.1
    statement: 需要系列を指定せずに作ったゲームには仮の既定の系列が入り、ゲームは「カスタム」になる
    category: policy
    applies_to: [Game.setupKind, DemandSeries]
    trigger: ゲームの作成（需要系列の指定なし）
    logic: THEN 仮の既定（週 1〜4 は 4、週 5 以降は 8）を入れ、setupKind を custom にする（U1 の BR1.6、BR1.7 を引き継ぐ）
    violation: なし
    source: FR1.3
  - id: BR6.2
    statement: JSD の既定の需要系列が未提供の間は、キット準拠のプリセットで作っても「カスタム」になる
    category: policy
    applies_to: [KitPreset.demandSeries, Game.setupKind]
    trigger: ゲームの作成（キット準拠のプリセットの指定）
    logic: IF KitPreset の需要系列が未提供 THEN setupKind を custom にし、キット準拠とは表示しない
    violation: なし
    source: FR1.7
  - id: BR6.3
    statement: 設定が KitPreset の全項目（需要系列を含む）と一致するときだけ「キット準拠」と判定する
    category: calculation
    applies_to: [Game.setupKind]
    trigger: ゲームの作成
    logic: IF 週数、初期在庫、初期パイプライン数量、在庫単価、受注残単価、遅延の週数、需要系列のすべてが KitPreset と一致し、かつ KitPreset の需要系列が提供されている THEN setupKind を kit にする。どれか 1 つでも違う、または未提供 THEN custom
    violation: なし
    source: FR1.5
  - id: BR6.4
    statement: 種別の区別は、結果の出力に残る
    category: constraint
    applies_to: [Game.setupKind, 出力]
    trigger: 結果の出力
    logic: THEN setupKind を出力に含める。週数などを変えたゲームは「カスタム」として出力される。出力の実装は U5 で、U2 は setupKind が作成時に決まり変わらないことを保証する
    violation: なし
    source: FR1.5
  - id: BR6.5
    statement: キット準拠の初期状態では、各役割の第 1 週・第 2 週の入荷は、配送の枠に最初から入っている数量（4）になり、第 3 週の入荷から第 1 週以降の出荷が加わる
    category: calculation
    applies_to: [PipelineSlot, WeekRecord.receipt]
    trigger: 週の確定（第 1 週、第 2 週、第 3 週）
    logic: THEN 初期の枠（remainingWeeks 1 と 2）が第 1 週と第 2 週の入荷になり、第 1 週の出荷は第 3 週の入荷になる（U1 の BR5.4）
    violation: なし
    source: FR1.5
  - id: BR7.1
    statement: 同じ週の確定が同時に届いても、週は一度だけ確定される
    category: constraint
    applies_to: [Game, WeekRecord]
    trigger: 週の確定（同時に 2 件以上）
    logic: THEN ゲーム単位の直列処理（U1 の BR4.6）のなかで、先に処理された 1 件が確定し、後の件は確定済みとして前回と同じ結果を返す（識別子が同じ）か、状態の拒否を返す（識別子が違う）。確定の結果が二重に保存されることはない
    violation: 二重に確定した結果を残さない
    source: FR9.1
  - id: BR7.2
    statement: 確定の途中で保存に失敗したときは、確定前の状態のまま残り、一部も残らない
    category: constraint
    applies_to: [Game]
    trigger: 週の確定（保存の失敗）
    logic: THEN 確定のすべての書き込み（4 役割の記録、枠の前進、週の進行、冪等性の記録、版の更新）を 1 つの保存の単位とし、どの時点の失敗でも全体を元に戻す。復旧後の状態の取得は、確定前の状態を返す
    violation: 500 internal。確定前の状態のまま
    source: FR9.2
  - id: BR7.3
    statement: 入力の送信が 2 回届いても、入力は 1 件として扱われる
    category: constraint
    applies_to: [WeekRecord.decision]
    trigger: 入力の要求（同じ識別子、同じ内容）
    logic: THEN 2 回目は前回の結果を返し、入力を重ねて保存しない。同じ識別子で内容が違うときは conflict（U1 の BR4.7）
    violation: 409 conflict（内容が違うとき）
    source: FR7.3
  - id: BR7.4
    statement: 前の週の確定済みの記録が見つからないときは、0 を代入せず、失敗にする
    category: constraint
    applies_to: [第 2 週以降の確定]
    trigger: 週の確定（第 2 週以降）
    logic: IF 前の週の確定済みの記録（在庫、受注残、累積費用）が欠けている THEN 確定を行わず、500 internal を返し、状態は変えない。記録の欠損を誤った数値の確定にしない
    violation: 500 internal。状態は変わらない
    source: FR9.2
  - id: BR8.1
    statement: 設定値は、週の確定が必ず成功する範囲に制限する
    category: validation
    applies_to: [GameSettings, DemandSeries]
    trigger: ゲームの作成
    logic: IF 初期在庫が 9999 を超える、初期パイプライン数量が 9999 を超える、在庫単価または受注残単価が 10000（$100.00）を超える、需要系列のいずれかの値が 9999 を超える THEN 422 validation で拒否し、項目と上限を案内する。上限の内側の値では、50 週の累積費用が 64 ビット整数（BR8.2）に収まり、確定が失敗しない
    violation: 拒否する（422 validation）。入力済みの他の項目は残す
    source: FR1.4
  - id: BR8.2
    statement: 費用は 64 ビット整数で保存し、上限の設定でも 50 週の累積が収まる
    category: constraint
    applies_to: [WeekRecord.weeklyCost, WeekRecord.cumulativeCost]
    trigger: 週の確定
    logic: THEN 週の在庫は初期在庫 + 全入荷、受注残は全受注を超えない。上限の設定（BR8.1）での最大の週次費用はおよそ 1.1 × 10 の 10 乗、50 週の累積はおよそ 5.2 × 10 の 11 乗で、64 ビット整数と JavaScript の安全な整数（2 の 53 乗未満）の両方に収まる
    violation: なし
    source: FR10.2
  - id: BR8.3
    statement: 同じ初期状態と意思決定系列からは、50 週すべての状態と費用が、何度実行しても同じになる
    category: calculation
    applies_to: [SimulationEngine]
    trigger: 週の計算（50 週）
    logic: THEN 計算は時計、乱数、保存、通信に触れない。同じ入力は同じ出力。期待値は、実装とは別の計算で作り、ファイルに固定する（Q2 の A）。実装を変えても期待値は変えない
    violation: なし
    source: NFR1
```

## 規則の概要

| グループ | 規則 | 内容 |
| :--- | :--- | :--- |
| 6 キット準拠とカスタム | BR6.1〜BR6.5 | 仮の既定、未提供の間の扱い、判定の条件、出力に残る区別、初期の入荷 |
| 7 原子性と冪等性の強化 | BR7.1〜BR7.4 | 同時の確定、途中の失敗、入力の二重送信、前週の記録の欠損 |
| 8 再現性と上限 | BR8.1〜BR8.3 | 設定値の上限、費用の保存、50 週の再現性 |

## 上流の資料

`requirements.md`、`stories.md`、`rules.md`（U1）、`functional-design-questions.md`
