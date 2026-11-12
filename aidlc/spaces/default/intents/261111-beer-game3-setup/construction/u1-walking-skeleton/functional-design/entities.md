# 実体の定義 - U1 u1-walking-skeleton

U1（薄い一通り）が作る実体の形を定めます。実体の所有は `components.md` に従います。ここでは、型、制約、取りうる値、関連の多重度を定めます。U1 が扱わない実体（OperationLogEntry、RetentionPolicy）は、それを作る Unit（U3、U5）で定めます。

出典: `components.md`、`unit-of-work.md`、`contract-summary.md`、`requirements.md`、`stories.md`。

## 実体の一覧（YAML が正本）

```yaml
entities:
  - name: Game
    owner: GameSession
    description: ゲーム全体の集約の根。状態は準備中、進行中、終了のいずれか（一時停止は U3 で足す）
    attributes:
      - { name: gameId, type: uuid, required: true, unique: true }
      - { name: name, type: text, required: true, constraints: "1〜60 文字" }
      - { name: status, type: enum, required: true, allowed: [preparing, running, ended], default: preparing }
      - { name: weekCount, type: integer, required: true, min: 1, max: 50 }
      - { name: currentWeek, type: integer, required: true, min: 1, default: 1, constraints: "終了時は終了した時点の週のまま。最終週の確定で終了したとき（endReason が finalWeek）は weekCount になる（途中で終了したときは weekCount より小さい。`construction/u3-facilitation/functional-design/entities.md` の Game の制約が正本）" }
      - { name: setupKind, type: enum, required: true, allowed: [kit, custom], default: custom, constraints: "U1 では常に custom。判定は U2" }
      - { name: version, type: integer, required: true, default: 0, constraints: "保存のたびに 1 増える" }
      - { name: createdAt, type: timestamp, required: true, constraints: "UTC" }
      - { name: endedAt, type: timestamp, required: false }
    relationships: []
    constraints:
      - status が running のとき currentWeek は 1 以上 weekCount 以下
      - status が ended のとき endedAt を持つ

  - name: GameSettings
    owner: GameSession
    description: ゲーム作成時に固定される設定。作成後に U1 では変更しない
    attributes:
      - { name: settingsId, type: uuid, required: true, unique: true }
      - { name: gameId, type: uuid, required: true, unique: true, references: Game }
      - { name: weekCount, type: integer, required: true, min: 1, max: 50, constraints: "Game.weekCount と同じ値。作成時に固定され、変更しない" }
      - { name: initialInventory, type: integer, required: true, min: 0, default: 12 }
      - { name: initialPipelineQuantity, type: integer, required: true, min: 0, default: 4 }
      - { name: inventoryUnitCost, type: integer, required: true, min: 0, default: 50, constraints: "最小単位（セント）。$0.50" }
      - { name: backlogUnitCost, type: integer, required: true, min: 0, default: 100, constraints: "最小単位（セント）。$1.00" }
      - { name: visibilityScope, type: enum, required: true, allowed: [team_totals], default: team_totals }
    relationships:
      - { to: Game, cardinality: "1:1", direction: "GameSettings → Game" }
    constraints:
      - 遅延の週数（配送 2、注文 2、生産 2）は設定項目ではなく固定

  - name: DemandSeries
    owner: GameSession
    description: 顧客需要の系列。長さは weekCount と等しい
    attributes:
      - { name: seriesId, type: uuid, required: true, unique: true }
      - { name: settingsId, type: uuid, required: true, unique: true, references: GameSettings }
      - { name: values, type: "整数の並び", required: true, constraints: "各要素は 0 以上の整数。要素数は weekCount と等しい" }
      - { name: isProvisionalDefault, type: boolean, required: true, default: false }
    relationships:
      - { to: GameSettings, cardinality: "1:1", direction: "DemandSeries → GameSettings" }
    constraints:
      - 指定がないときは仮の既定（週 1〜4 は 4、週 5 以降は 8）を入れ、isProvisionalDefault を true にする

  - name: Participant
    owner: GameSession
    description: ゲームに参加した人。表示名以外の個人情報を持たない
    attributes:
      - { name: participantId, type: uuid, required: true, unique: true }
      - { name: gameId, type: uuid, required: true, references: Game }
      - { name: displayName, type: text, required: true, constraints: "1〜40 文字。同名を許す" }
      - { name: joinOrder, type: integer, required: true, min: 1, constraints: "ゲーム内で参加順に 1 から。同名を区別する印" }
      - { name: joinedAt, type: timestamp, required: true }
    relationships:
      - { to: Game, cardinality: "N:1", direction: "Participant → Game" }
    constraints:
      - (gameId, joinOrder) は一意

  - name: RoleAssignment
    owner: GameSession
    description: 参加者を役割に就ける割当て
    attributes:
      - { name: assignmentId, type: uuid, required: true, unique: true }
      - { name: gameId, type: uuid, required: true, references: Game }
      - { name: participantId, type: uuid, required: true, unique: true, references: Participant }
      - { name: role, type: enum, required: true, allowed: [factory, wholesaler1, wholesaler2, retailer] }
    relationships:
      - { to: Participant, cardinality: "1:1", direction: "RoleAssignment → Participant" }
    constraints:
      - 1 人の参加者は最大 1 つの役割に就く
      - 1 つの役割に就ける人数は 4 人まで（components.md の定員。U1 から守る）
      - 開始の条件は、4 つの役割それぞれに 1 人以上が就いていること

  - name: WeekRecord
    owner: GameSession
    description: 週ごと、役割ごとの記録。確定前は意思決定の入力だけを持ち、確定時に結果を持つ
    attributes:
      - { name: weekRecordId, type: uuid, required: true, unique: true }
      - { name: gameId, type: uuid, required: true, references: Game }
      - { name: week, type: integer, required: true, min: 1, max: 50 }
      - { name: role, type: enum, required: true, allowed: [factory, wholesaler1, wholesaler2, retailer] }
      - { name: decision, type: integer, required: false, min: 0, max: 9999, constraints: "発注数。工場は生産要請数。未入力は null" }
      - { name: receipt, type: integer, required: false, min: 0, constraints: "確定後に入る" }
      - { name: ordersReceived, type: integer, required: false, min: 0 }
      - { name: shipped, type: integer, required: false, min: 0 }
      - { name: inventory, type: integer, required: false, min: 0, constraints: "週末在庫。負にならない" }
      - { name: backlog, type: integer, required: false, min: 0, constraints: "週末受注残。負にならない" }
      - { name: weeklyCost, type: integer, required: false, min: 0, constraints: "最小単位（セント）" }
      - { name: cumulativeCost, type: integer, required: false, min: 0, constraints: "最小単位（セント）" }
      - { name: isConfirmed, type: boolean, required: true, default: false }
    relationships:
      - { to: Game, cardinality: "N:1", direction: "WeekRecord → Game" }
    constraints:
      - (gameId, week, role) は一意
      - isConfirmed が false のとき、decision 以外の結果の項目は null
      - isConfirmed が true のとき、すべての結果の項目が埋まり、decision も埋まる

  - name: PipelineSlot
    owner: GameSession
    description: 遅延の枠。配送、注文、生産の 3 種類を、週単位で前進させる
    attributes:
      - { name: pipelineSlotId, type: uuid, required: true, unique: true }
      - { name: gameId, type: uuid, required: true, references: Game }
      - { name: kind, type: enum, required: true, allowed: [delivery, order, production] }
      - { name: role, type: enum, required: true, allowed: [factory, wholesaler1, wholesaler2, retailer], constraints: "届く側の役割" }
      - { name: remainingWeeks, type: integer, required: true, min: 1, max: 2, constraints: "週の確定の前の状態で、1 は当週に届く（当週の入荷または受注になる）、2 は次の週に届く。確定のたびに 2 は 1 になり、1 は消費される" }
      - { name: quantity, type: integer, required: true, min: 0 }
    relationships:
      - { to: Game, cardinality: "N:1", direction: "PipelineSlot → Game" }
    constraints:
      - (gameId, kind, role, remainingWeeks) は一意
      - kind が production の role は factory のみ
      - kind が delivery の role は wholesaler1、wholesaler2、retailer（小売店への出荷は卸から、卸への出荷は上流から）
      - kind が order の role は factory、wholesaler1、wholesaler2（届く先は上流側。小売店の受注は顧客需要で、枠を持たない）

  - name: AccessCode
    owner: AccessControl
    description: 参加コード、進行役用コード、観察者用コード。作成時に 1 つのゲームに対して 3 種類を発行する
    attributes:
      - { name: codeId, type: uuid, required: true, unique: true }
      - { name: gameId, type: uuid, required: true, references: Game }
      - { name: kind, type: enum, required: true, allowed: [join, facilitator, observer] }
      - { name: codeHash, type: text, required: true, unique: true, constraints: "コードの照合に使うハッシュ" }
      - { name: codeSealed, type: text, required: false, constraints: "再表示のために保存する、暗号化した値。join と observer だけが持ち、facilitator は null（再表示も再発行もしない）。暗号化の方式と鍵の扱いは NFR Design で定める" }
      - { name: issuedAt, type: timestamp, required: true }
      - { name: revokedAt, type: timestamp, required: false }
    relationships:
      - { to: Game, cardinality: "N:1", direction: "AccessCode → Game" }
    constraints:
      - (gameId, kind) は一意（1 つのゲームに各種類 1 つ）
      - join は 8 文字以上の英数字。facilitator と observer は暗号論的乱数による 128 ビット以上

  - name: ReturnToken
    owner: AccessControl
    description: 参加者を特定する token。U1 は参加時の発行と要求ごとの検証だけを持つ。有効期間、失効、再発行は U4 が足す
    attributes:
      - { name: tokenId, type: uuid, required: true, unique: true }
      - { name: participantId, type: uuid, required: true, references: Participant }
      - { name: tokenHash, type: text, required: true, unique: true, constraints: "token そのものは保存せず、ハッシュを保存する" }
      - { name: issuedAt, type: timestamp, required: true }
      - { name: revokedAt, type: timestamp, required: false, constraints: "U1 では常に null。値の設定は U3 の入れ替えと U4" }
    relationships:
      - { to: Participant, cardinality: "N:1", direction: "ReturnToken → Participant" }
    constraints:
      - token は 128 ビット以上の暗号論的乱数

  - name: IdempotencyRecord
    owner: GameSession
    description: 利用者が付ける識別子で、入力と週確定の再送を同じ結果にするための記録
    attributes:
      - { name: recordId, type: uuid, required: true, unique: true }
      - { name: gameId, type: uuid, required: true, references: Game }
      - { name: key, type: text, required: true, constraints: "16〜128 文字" }
      - { name: operation, type: enum, required: true, allowed: [submitDecision, confirmWeek] }
      - { name: requesterId, type: text, required: true, constraints: "呼び出した人（参加者の識別子、または進行役）。別の人の記録の結果を返さないために持つ" }
      - { name: requestDigest, type: text, required: true, constraints: "要求の内容の要約。同じ識別子で内容が違うことを検出する" }
      - { name: responseBody, type: 構造化された値, required: true, constraints: "前回返した結果" }
      - { name: createdAt, type: timestamp, required: true }
    relationships:
      - { to: Game, cardinality: "N:1", direction: "IdempotencyRecord → Game" }
    constraints:
      - (gameId, operation, requesterId, key) は一意。有効範囲はゲーム内で、呼び出した人ごとに照合する
      - ゲームの削除（U5）と同時に削除される
```

## 概要

| 実体 | 所有する部品 | 役割 |
| :--- | :--- | :--- |
| Game | GameSession | 集約の根。状態と週を持つ |
| GameSettings | GameSession | 作成時に固定される設定 |
| DemandSeries | GameSession | 顧客需要の系列 |
| Participant | GameSession | 参加者（表示名だけ） |
| RoleAssignment | GameSession | 参加者と役割の割当て |
| WeekRecord | GameSession | 週ごと、役割ごとの入力と結果 |
| PipelineSlot | GameSession | 遅延の枠 |
| AccessCode | AccessControl | 3 種類のコード（ハッシュで保存） |
| ReturnToken | AccessControl | 参加者を特定する token（ハッシュで保存） |
| IdempotencyRecord | GameSession | 再送を同じ結果にする記録 |

## 契約への反映

前の工程のレビューで、保存先を持たない契約があると指摘されました。U1 では次のように定めます。`contract-summary.md` の C3 は、この定義が正本です。

- `access_codes` と `return_tokens`（基本の列だけ）と `idempotency_records` の表は、U1 が作る。U4 は `return_tokens` に有効期間と最後の操作の時刻を足す。
- 冪等性の記録の有効範囲はゲーム内（呼び出した人ごと）、保持期間はゲームと同じ。同じ識別子で内容が違うときは、409 の `conflict` で返す。
- 参加コードと観察者用コードは、進行役が共有するために再表示できる形（暗号化）で保存する。進行役用コードはハッシュだけで、紛失しても再表示も再発行もしない（`requirements.md` の前提）。
- `components.md` の GameSession の所有一覧に IdempotencyRecord を足す（所有は GameSession）。`weekCount` は Game と GameSettings の両方が持ち、作成時に同じ値を入れる。
- 契約の `Problem` に、ゲームの行の占有を待てなかったときの `unavailable`（HTTP 503）を足す。`contract-summary.md` を同時に直した。

## 上流の資料

`components.md`、`unit-of-work.md`、`contract-summary.md`、`requirements.md`、`stories.md`
