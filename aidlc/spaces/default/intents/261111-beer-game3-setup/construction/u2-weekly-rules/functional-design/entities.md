# 実体の定義 - U2 u2-weekly-rules

U2（週次ルールの完成）は、U1 の実体を使い、少数の変更を足します。新しい保存先の表は作りません。

出典: U1 の `entities.md`、`components.md`、`requirements.md`（FR1.5、FR1.7、FR9）、`functional-design-questions.md`（Q1 未提供、Q3 上限）。

## 実体の一覧（YAML が正本）

```yaml
entities:
  - name: KitPreset
    owner: GameSession
    description: キット準拠のプリセット（値の集まり）。保存せず、コードの中の定義として持つ。判定の基準になる
    attributes:
      - { name: weekCount, type: integer, required: true, constraints: "50" }
      - { name: initialInventory, type: integer, required: true, constraints: "12（工場を含む各役割）" }
      - { name: initialPipelineQuantity, type: integer, required: true, constraints: "4（配送、注文、生産の各枠）" }
      - { name: inventoryUnitCost, type: integer, required: true, constraints: "50（セント）" }
      - { name: backlogUnitCost, type: integer, required: true, constraints: "100（セント）" }
      - { name: delayWeeks, type: integer, required: true, constraints: "2 で固定（配送、注文、生産）" }
      - { name: demandSeries, type: "整数の並び", required: false, constraints: "JSD の既定の系列。確定するまで「未提供」（null）。確定したら 50 週分の値を入れる" }
    relationships: []
    constraints:
      - demandSeries が未提供の間は、どのゲームも「キット準拠」と判定されない

  - name: Game
    owner: GameSession
    description: U1 の Game。U2 は setupKind の決め方を定める
    attributes:
      - { name: setupKind, type: enum, required: true, allowed: [kit, custom], constraints: "作成のとき、KitPreset との全項目の一致で決める。作成後は変わらない" }
    relationships: []
    constraints:
      - setupKind が kit のゲームは、設定が KitPreset と全項目一致する

  - name: GameSettings
    owner: GameSession
    description: U1 の GameSettings。U2 は各値の上限を定める
    attributes:
      - { name: initialInventory, type: integer, required: true, min: 0, max: 9999 }
      - { name: initialPipelineQuantity, type: integer, required: true, min: 0, max: 9999 }
      - { name: inventoryUnitCost, type: integer, required: true, min: 0, max: 10000, constraints: "セント。上限は $100.00" }
      - { name: backlogUnitCost, type: integer, required: true, min: 0, max: 10000, constraints: "セント。上限は $100.00" }
    relationships: []
    constraints:
      - 上限の内側の値なら、50 週の確定が必ず成功する（BR8.1）

  - name: DemandSeries
    owner: GameSession
    description: U1 の DemandSeries。U2 は各値の上限を定める
    attributes:
      - { name: values, type: "整数の並び", required: true, constraints: "各要素は 0 以上 9999 以下の整数。要素数は weekCount と等しい" }
    relationships: []
    constraints: []

  - name: WeekRecord
    owner: GameSession
    description: U1 の WeekRecord。U2 は費用の列を 64 ビット整数にする
    attributes:
      - { name: weeklyCost, type: "64 ビット整数", required: false, min: 0, constraints: "最小単位（セント）" }
      - { name: cumulativeCost, type: "64 ビット整数", required: false, min: 0, constraints: "最小単位（セント）。50 週分が収まる" }
    relationships: []
    constraints: []
```

## 概要

| 実体 | U2 での扱い |
| :--- | :--- |
| KitPreset | 新しい。保存しない定義。需要系列は未提供 |
| Game | setupKind を KitPreset との一致で決める |
| GameSettings | 各値に上限を足す |
| DemandSeries | 各値に上限を足す |
| WeekRecord | 費用の列を 64 ビット整数に変える（既存の表への移行） |

## 移行

`week_records` の `weekly_cost` と `cumulative_cost` を 64 ビット整数（`bigint`）に変える移行を足す。既存の値は変わらない。アプリケーションでは、安全な整数の範囲（2 の 53 乗未満）に収まるため、数値としてそのまま扱える（上限のとき、50 週の累積は約 5 × 10 の 11 乗）。

## 上流の資料

`entities.md`（U1）、`components.md`、`requirements.md`、`functional-design-questions.md`
