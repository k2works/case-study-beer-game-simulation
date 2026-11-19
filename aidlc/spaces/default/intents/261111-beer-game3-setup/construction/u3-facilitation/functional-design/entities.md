# 実体の定義 - U3 u3-facilitation

U3（運営操作）が足す実体と、U1 の実体への追加を定めます。U1 の実体の形（`u1-walking-skeleton/functional-design/entities.md`）は変えず、項目を足すだけです。U3 が新しく作るのは `OperationLogEntry` です。

出典: `components.md`、`unit-of-work.md`、`contract-summary.md`（C1、C3、C5）、`requirements.md`（FR2.4、FR3.2、FR3.3、FR4.5、FR11）、`stories.md`（US2.2、US2.3、US2.5〜US2.8、US5.6）、`functional-design-questions.md`（Q1〜Q8）。

## 実体の一覧（YAML が正本）

```yaml
entities:
  - name: OperationLogEntry
    owner: GameSession
    description: 進行役の操作とゲームの状態の変化の履歴。追記だけで、変更も削除もしない。操作と同じ保存の中で書く（ADR-004）
    attributes:
      - { name: entryId, type: uuid, required: true, unique: true }
      - { name: gameId, type: uuid, required: true, references: Game }
      - { name: sequence, type: integer, required: true, min: 1, constraints: "ゲーム内で 1 から連番。履歴の順序の正本" }
      - { name: kind, type: enum, required: true, allowed: [setting, roleChange, proxyInput, weekConfirm, pause, resume, end], constraints: "AC5.6.1 の 7 種類" }
      - { name: actorKind, type: enum, required: true, allowed: [facilitator, system], constraints: "誰が。進行役の操作は facilitator。最終週の確定による自動終了は system（自動終了の autoEnd は U5 が足す）" }
      - { name: occurredAt, type: timestamp, required: true, constraints: "UTC。時刻は注入した時計から得る" }
      - { name: week, type: integer, required: false, min: 1, max: 50, constraints: "操作の時点の週。setting は null" }
      - { name: role, type: enum, required: false, allowed: [factory, wholesaler1, wholesaler2, retailer], constraints: "対象の役割。roleChange と proxyInput で持つ" }
      - { name: detail, type: 構造化された値, required: true, constraints: "kind ごとの何を。下の kind ごとの内容に従う。復帰用 token と進行役用コードの平文を含めない" }
    relationships:
      - { to: Game, cardinality: "N:1", direction: "OperationLogEntry → Game" }
    constraints:
      - (gameId, sequence) は一意。追記のたびに 1 増える
      - 作成後に更新も削除もしない。ゲームの削除（U5）と同時に削除される
      - kind ごとの detail の内容は次のとおり
      - "setting: { weekCount, initialInventory, initialPipelineQuantity, inventoryUnitCost, backlogUnitCost, setupKind, demandSeriesLength, demandSeriesIsProvisional }"
      - "roleChange: { change: assign | reassign | replace, participantId, participantLabel, fromRole（reassign のとき）, toRole, replacedParticipantId と replacedParticipantLabel（replace のとき）, gameStatus }"
      - "proxyInput: { value }（week と role は列に持つ）"
      - "weekConfirm: { week }（確定した週）"
      - "pause と resume: { week }（停止または再開した時点の週）"
      - "end: { reason: facilitator | finalWeek | autoEnd, week }"

  - name: Game
    owner: GameSession
    description: U1 の Game への追加。一時停止の状態と、終了の理由を足す
    attributes:
      - { name: status, type: enum, required: true, allowed: [preparing, running, paused, ended], default: preparing, constraints: "U1 の [preparing, running, ended] に paused を足す" }
      - { name: endReason, type: enum, required: false, allowed: [facilitator, finalWeek, autoEnd], constraints: "status が ended のときだけ持つ。終了の理由。autoEnd の値は U5 が使う" }
    relationships: []
    constraints:
      - status が paused のとき currentWeek は 1 以上 weekCount 以下で、一時停止の前から変わらない
      - status が ended のとき endedAt と endReason を持つ
      - 遷移は preparing → running ⇄ paused、running または paused → ended、および preparing → ended（reason が autoEnd のときだけ。U5 の自動終了）のみ。ended からは戻らない
      - currentWeek は終了した時点の週のまま変えない。最終週の確定で終了したとき（finalWeek）は weekCount になり、進行役が途中で終了したとき（facilitator）は weekCount より小さくなる。U1 の「終了時は weekCount のまま」は、finalWeek の場合に限る、に直す
      - 途中で終了したとき、その週の WeekRecord は isConfirmed が false のまま残る。結果と出力（U5）は確定済みの週だけを対象にする
      - U3 の移行の前から ended の行は、最終週の確定で終了したものだけ（U1 には途中終了がない）なので、移行で endReason に finalWeek を補う

  - name: WeekRecord
    owner: GameSession
    description: U1 の WeekRecord への追加。入力した主体と、置き換わりの検出に使う項目を足す
    attributes:
      - { name: decidedByKind, type: enum, required: false, allowed: [participant, facilitator], constraints: "decision を最後に保存した主体。decision が null のときは null" }
      - { name: decidedByParticipantId, type: uuid, required: false, references: Participant, constraints: "decidedByKind が participant のとき持つ。facilitator のときは null" }
      - { name: decidedAt, type: timestamp, required: false, constraints: "decision を最後に保存した時刻" }
      - { name: decisionRevision, type: integer, required: true, min: 0, default: 0, constraints: "decision を保存するたびに 1 増える。画面が置き換わりを検出するために使う（上書きでも、同じ値の再保存でも増える）" }
    relationships:
      - { to: Participant, cardinality: "N:1", direction: "WeekRecord → Participant" }
    constraints:
      - decision が null のとき decidedByKind、decidedByParticipantId、decidedAt は null で、decisionRevision は 0
      - decision が値を持つとき decidedByKind と decidedAt が埋まり、decisionRevision は 1 以上
      - 確定済み（isConfirmed が true）の WeekRecord は、これらの項目も変えない

  - name: Participant
    owner: GameSession
    description: U1 の Participant への追加。入れ替えで交代した印を足す
    attributes:
      - { name: replacedAt, type: timestamp, required: false, constraints: "入れ替えで役割を離れた時刻。交代前の担当者の記録（入力、履歴）は残すため、参加者の行は消さない" }
      - { name: createdByFacilitator, type: boolean, required: true, default: false, constraints: "入れ替えで進行役が作った参加者は true。参加コードで参加した参加者は false" }
    relationships: []
    constraints:
      - replacedAt を持つ参加者は RoleAssignment を持たず、復帰用 token は失効している
      - 表示の名前（ラベル）は「表示名 #参加順」で、保存せず表示名と joinOrder から作る

  - name: RoleAssignment
    owner: GameSession
    description: U1 の RoleAssignment への追加。入れ替えでの付け替えを定める
    attributes: []
    relationships: []
    constraints:
      - 進行中と一時停止中の入れ替えは、同じ役割で、旧担当者の割当てを消し、新しい参加者の割当てを足す。役割ごとの人数は変わらない
      - 1 つの役割に就ける人数は 4 人まで。準備中の追加、付け替え、入れ替えのどの経路でも守る

  - name: ReturnToken
    owner: AccessControl
    description: U1 の ReturnToken への追加。入れ替えでの失効と再発行を定める
    attributes: []
    relationships: []
    constraints:
      - 入れ替えで、旧担当者の token は revokedAt を設定して失効する。新しい担当者には新しい token を発行する（128 ビット以上の暗号論的乱数、ハッシュで保存）
      - 失効した token での要求は forbidden として拒否する。有効期間と試行回数の制限は U4 が足す

  - name: IdempotencyRecord
    owner: GameSession
    description: U1 の IdempotencyRecord。U3 は新しい操作の種類を足さない
    attributes: []
    relationships: []
    constraints:
      - 進行役の代理入力は submitDecision の記録を使い、requesterId を進行役にする（参加者の記録と混ざらない）
      - 一時停止、再開、終了、入れ替えは識別子を使わない。再送の安全は状態の検査で守る（終了は冪等、入れ替えは旧担当者がすでに交代済みなら conflict）
```

## 概要

| 実体 | 所有する部品 | U3 での役割 |
| :--- | :--- | :--- |
| OperationLogEntry | GameSession | 7 種類の操作の履歴。追記だけ |
| Game | GameSession | paused の状態と、終了の理由を足す |
| WeekRecord | GameSession | 入力した主体と置き換わりの検出の項目を足す |
| Participant | GameSession | 交代した印と、進行役が作った印を足す |
| RoleAssignment | GameSession | 入れ替えでの付け替えと定員 4 人を定める |
| ReturnToken | AccessControl | 入れ替えでの失効と再発行を定める |
| IdempotencyRecord | GameSession | 新しい種類は足さない |

## 契約への反映

- `operation_log_entries` の表は、U3 が別の移行として足す（C3 の ownership のとおり）。`games` に `end_reason`、`week_records` に入力した主体の項目、`participants` に交代した印の列を足す。どれも追加で、既存の列は削除も意味の変更もしない。
- `Game.status` に `paused` を足すため、`GameStateView.status` の enum に `paused` が加わる。`contract-summary.md` の C1 にはすでに `paused` がある。
- U1 の `entities.md` の Game の制約「終了時は weekCount のまま」は、最終週の確定で終了したときに限る、に直す（上の Game の制約が正本）。`contract-summary.md` の C1 の `PUT /games/{gameId}/assignments/{participantId}` は、進行中と一時停止中は常に 409 `state` とし、入れ替えは `POST /games/{gameId}/roles/{role}/replacement` を使う、に直す（`functional-spec.md` の「契約への反映」が正本）。
- 履歴は GameSession の保存の一部として書く。U1 の作成、割当て、週確定の保存も、U3 の移行の後は、同じ保存の中で履歴を足す（U1 のコードは履歴に依存しないまま、履歴を足す形に開けておく。`unit-of-work-story-map.md` の「履歴の記録」）。
