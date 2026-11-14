# 実体の定義 - U5 u5-results-retention

U5（結果と出力、保持と削除）が足す実体と、U1・U3 の実体への追加を定めます。U5 が足す永続の実体はありません。足すのは `Game` の 1 つの列（`lastOperationAt`）と、保存しない値（結果の投影、出力、保持の設定、定期処理の結果）です。保持期間はアプリケーションの設定だけで持つ（Q3 の A）ため、契約 C3 が U5 の表として挙げていた `retention_policies` は作りません。

出典: `components.md`、`unit-of-work.md`、`contract-summary.md`（C1、C3、C5）、`requirements.md`（FR10.2、FR13、FR14、NFR7、NFR9）、`stories.md`（US4.1、US4.2、US5.1）、`functional-design-questions.md`（Q1〜Q9）。

## 実体の一覧（YAML が正本）

```yaml
entities:
  - name: Game
    owner: GameSession
    description: U1・U3 の Game への追加。放置の判定に使う「最後の操作の時刻」を足す。契約 C3 のとおり、U5 が別の移行で列を足す
    attributes:
      - { name: lastOperationAt, type: timestamp, required: true, default: createdAt, constraints: "UTC。状態を変えた最後の操作の時刻。作成時は createdAt と同じ。更新は BR25.2 の操作だけ" }
    relationships: []
    constraints:
      - lastOperationAt は createdAt 以上で、時間とともに減らない
      - 閲覧、冪等の再送（状態を変えないもの）、拒否された要求では更新しない
      - 操作の保存と同じ保存の中で更新する（別の保存で後から更新しない）
      - 既存の行の移行では、実際の最後の操作より古くならないように埋める。createdAt、履歴の最後の occurredAt、参加者の参加の時刻、週の記録の decidedAt のうち、最も遅いもので埋める（参加と開始と参加者の入力は履歴に残らないため、履歴だけでは古く見積もり、移行の直後に早すぎる自動終了が起きる）
      - 終了したゲームでは更新しない。終了の時刻は endedAt が持つ

  - name: RetentionPolicy
    owner: Retention
    description: 保持と自動終了の方針。永続の実体ではなく、アプリケーションの設定から読む値。全ゲームに共通で、ゲームごとには持たない（Q3 の A）
    attributes:
      - { name: retentionDays, type: integer, required: true, default: 30, min: 1, max: 3650, constraints: "終了から削除までの日数。仮の値（NFR7）。NFR 要件の工程で確定する" }
      - { name: autoEndDays, type: integer, required: true, default: 30, min: 1, max: 3650, constraints: "最後の操作から自動終了までの日数。仮の値（NFR7）" }
      - { name: jobIntervalMinutes, type: integer, required: true, default: 60, min: 1, max: 1440, constraints: "定期処理の間隔。仮の値" }
      - { name: batchLimit, type: integer, required: true, default: 100, min: 1, max: 1000, constraints: "1 回の処理で、自動終了と削除のそれぞれに扱うゲームの数の上限。仮の値" }
    relationships: []
    constraints:
      - 値は起動時に一度読み、範囲の外なら起動を拒否する（設定の誤りは起動時に分かる）
      - 設定を変えると、次の処理から新しい値で判定する。すでに終了したゲームにも適用する（BR24.2）
      - 時刻の判定は、注入した Clock の現在時刻で行う

  - name: ResultsView
    owner: Reporting
    description: 終了したゲームの全役割の時系列を、比較表示のために整えた投影。保存しない。契約 C1 の GET /games/{gameId}/results の応答の形
    attributes:
      - { name: gameId, type: string, required: true }
      - { name: setupKind, type: enum, required: true, allowed: [kit, custom], constraints: "画面に出す種別は U2 の判定に従う" }
      - { name: weekCount, type: integer, required: true, min: 1, max: 50 }
      - { name: confirmedWeeks, type: integer, required: true, min: 0, max: 50, constraints: "確定済みの週の数。途中で終了したゲームは weekCount より小さい" }
      - { name: customerDemand, type: "integer の列", required: true, constraints: "第 1 週から confirmedWeeks までの顧客需要。長さは confirmedWeeks" }
      - { name: roles, type: "ResultRole の列", required: true, constraints: "4 役割を factory、wholesaler1、wholesaler2、retailer の順に 1 つずつ" }
      - { name: teamCumulativeCost, type: integer, required: true, min: 0, constraints: "4 役割の最終の累積費用の合計。整数の最小単位（セント）。確定済みの週がなければ 0" }
    relationships:
      - { to: ResultRole, cardinality: "1 対 4", direction: owns }
    constraints:
      - 確定済みの週だけを含む。確定前の入力（decision が未確定の週）は含めない
      - 参加者の表示名、コード、token、ハッシュ、冪等の識別子を含めない
      - ゲームが終了していないときは作らない（BR21.1）

  - name: ResultRole
    owner: Reporting
    description: ResultsView の中の 1 役割の時系列
    attributes:
      - { name: role, type: enum, required: true, allowed: [factory, wholesaler1, wholesaler2, retailer] }
      - { name: weeks, type: "ResultWeek の列", required: true, constraints: "週の昇順。長さは confirmedWeeks" }
    relationships:
      - { to: ResultWeek, cardinality: "1 対 0..50", direction: owns }
    constraints: []

  - name: ResultWeek
    owner: Reporting
    description: 1 役割・1 週の確定済みの記録。WeekRecord から確定済みの値だけを写す
    attributes:
      - { name: week, type: integer, required: true, min: 1, max: 50 }
      - { name: receipt, type: integer, required: true, min: 0, constraints: "入荷" }
      - { name: ordersReceived, type: integer, required: true, min: 0, constraints: "受注。小売店では顧客需要と同じ。画面の「需要」の系列に使う（BR22.1）" }
      - { name: shipped, type: integer, required: true, min: 0, constraints: "出荷" }
      - { name: inventory, type: integer, required: true, min: 0, constraints: "週末在庫" }
      - { name: backlog, type: integer, required: true, min: 0, constraints: "週末受注残" }
      - { name: decision, type: integer, required: true, min: 0, max: 9999, constraints: "発注（工場では生産要請）。画面の「注文」の系列に使う" }
      - { name: weeklyCost, type: integer, required: true, min: 0, constraints: "当週費用。整数の最小単位（セント）" }
      - { name: cumulativeCost, type: integer, required: true, min: 0, constraints: "累積費用。整数の最小単位（セント）" }
    relationships: []
    constraints:
      - 値はすべて整数。浮動小数点を使わない（FR10.2）

  - name: ExportRecord
    owner: Reporting
    description: 出力の 1 行（1 週・1 役割）。CSV の 1 行と、JSON の records の 1 要素に共通の中間表現。保存しない
    attributes:
      - { name: gameId, type: string, required: true }
      - { name: setupKind, type: enum, required: true, allowed: [kit, custom] }
      - { name: week, type: integer, required: true, min: 1, max: 50 }
      - { name: role, type: enum, required: true, allowed: [factory, wholesaler1, wholesaler2, retailer] }
      - { name: customerDemand, type: integer, required: true, min: 0, constraints: "その週の顧客需要。4 役割の行で同じ値" }
      - { name: receipt, type: integer, required: true, min: 0 }
      - { name: ordersReceived, type: integer, required: true, min: 0 }
      - { name: shipped, type: integer, required: true, min: 0 }
      - { name: inventory, type: integer, required: true, min: 0 }
      - { name: backlog, type: integer, required: true, min: 0 }
      - { name: decision, type: integer, required: true, min: 0, max: 9999, constraints: "発注または生産要請" }
      - { name: weeklyCostCents, type: integer, required: true, min: 0 }
      - { name: cumulativeCostCents, type: integer, required: true, min: 0 }
      - { name: decidedByKind, type: enum, required: false, allowed: [participant, facilitator], constraints: "その週の decision を最後に保存した主体。移行前の記録は空" }
      - { name: decidedByDisplayName, type: string, required: false, constraints: "decidedByKind が participant のときだけ、その参加者の表示名。facilitator のときと空のときは空。入れ替え済みの参加者の表示名も含める" }
    relationships: []
    constraints:
      - CSV の列の順序は属性の並びのとおり。JSON の項目名は CSV の列名と同じ
      - 値は元のまま出す。表示名の先頭が =、+、-、@ でも変えない（BR23.3）
      - 空の値は、CSV では空のセル、JSON では null

  - name: ExportDocument
    owner: Reporting
    description: JSON の出力全体。game と records を持つ。CSV は records だけを同じ列で出す。保存しない
    attributes:
      - { name: game, type: ExportGame, required: true }
      - { name: records, type: "ExportRecord の列", required: true, constraints: "週の昇順、同じ週では factory、wholesaler1、wholesaler2、retailer の順" }
    relationships:
      - { to: ExportRecord, cardinality: "1 対 0..200", direction: owns }
    constraints:
      - records の件数は confirmedWeeks × 4
      - 参加コード、進行役用コード、観察者用コード、token、ハッシュ、冪等の識別子、操作の履歴を含めない（BR23.8）

  - name: ExportGame
    owner: Reporting
    description: ExportDocument の game。ゲーム設定の写し
    attributes:
      - { name: gameId, type: string, required: true }
      - { name: name, type: string, required: true }
      - { name: setupKind, type: enum, required: true, allowed: [kit, custom] }
      - { name: status, type: enum, required: true, allowed: [ended] }
      - { name: endReason, type: enum, required: true, allowed: [facilitator, finalWeek, autoEnd] }
      - { name: weekCount, type: integer, required: true, min: 1, max: 50 }
      - { name: confirmedWeeks, type: integer, required: true, min: 0, max: 50 }
      - { name: createdAt, type: timestamp, required: true }
      - { name: endedAt, type: timestamp, required: true }
      - { name: initialInventory, type: integer, required: true, min: 0 }
      - { name: initialPipelineQuantity, type: integer, required: true, min: 0 }
      - { name: inventoryUnitCostCents, type: integer, required: true, min: 0 }
      - { name: backlogUnitCostCents, type: integer, required: true, min: 0 }
      - { name: demandSeries, type: "integer の列", required: true, constraints: "weekCount 週分の顧客需要の系列（設定そのもの）" }
    relationships: []
    constraints:
      - 日時は ISO 8601 の UTC

  - name: RetentionRunResult
    owner: Retention
    description: 定期処理の 1 回分の結果。ログに出す。永続しない
    attributes:
      - { name: startedAt, type: timestamp, required: true }
      - { name: autoEnded, type: integer, required: true, min: 0, constraints: "自動終了したゲームの数" }
      - { name: deleted, type: integer, required: true, min: 0, constraints: "削除したゲームの数" }
      - { name: failed, type: integer, required: true, min: 0, constraints: "処理に失敗したゲームの数" }
      - { name: skipped, type: boolean, required: true, constraints: "排他を取れず、今回は何もしなかったとき true" }
      - { name: durationMs, type: integer, required: true, min: 0 }
    relationships: []
    constraints:
      - ゲームの識別子、削除の時刻、理由だけをゲームごとに残す。表示名、コード、token を含めない（BR24.6）
```

## 実体の概要

| 実体 | 種類 | U5 での変更 |
| :--- | :--- | :--- |
| Game | 永続 | `lastOperationAt` の列を足す（移行） |
| RetentionPolicy | 設定（保存しない） | 新しく定める。保持期間、自動終了の期間、周期、1 回の上限 |
| ResultsView、ResultRole、ResultWeek | 投影（保存しない） | 新しく定める。結果画面の応答 |
| ExportRecord、ExportDocument、ExportGame | 出力（保存しない） | 新しく定める。CSV と JSON の共通の中間表現 |
| RetentionRunResult | ログ（保存しない） | 新しく定める。定期処理の結果 |

## 上流の資料

`components.md`、`unit-of-work.md`、`contract-summary.md`、`requirements.md`、`stories.md`、`functional-design-questions.md`
