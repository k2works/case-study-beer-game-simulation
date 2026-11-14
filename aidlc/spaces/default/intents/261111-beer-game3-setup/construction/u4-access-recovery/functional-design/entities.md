# 実体の定義 - U4 u4-access-recovery

U4（復帰と権限）が足す実体と、U1・U3 の実体への追加を定めます。U1 の実体の形は変えず、項目を足すだけです。U4 が新しく足す永続の実体はありません。足すのは `ReturnToken` の列、保存しない値の 2 つ（試行の窓、観察者の投影）です。

出典: `components.md`、`unit-of-work.md`、`contract-summary.md`（C1、C3、C4）、`requirements.md`（FR2.3、FR4.1〜FR4.3、FR12、NFR5、NFR6）、`stories.md`（US2.1、US2.9、US3.1、US3.2、US5.4）、`functional-design-questions.md`（Q1〜Q10）。

## 実体の一覧（YAML が正本）

```yaml
entities:
  - name: ReturnToken
    owner: AccessControl
    description: U1 の ReturnToken への追加。最後の操作の時刻を足し、有効期間を判定できるようにする。契約 C3 のとおり、U4 が別の移行で列を足す
    attributes:
      - { name: lastUsedAt, type: timestamp, required: true, default: issuedAt, constraints: "UTC。最後の操作の時刻。発行時は issuedAt と同じ。更新は 1 分に 1 回まで（BR17.2）" }
    relationships: []
    constraints:
      - 有効期間は lastUsedAt からの経過時間で判定する。期間（既定 24 時間）は設定値で、NFR 要件の工程で確定する仮の値
      - 失効（revokedAt）は期限切れとは別に持つ。進行役の入れ替え（U3）が revokedAt を設定する
      - 期限切れで行は変えない。判定のたびに lastUsedAt と現在の時刻を比べる
      - 既存の行の移行では、lastUsedAt を issuedAt で埋める

  - name: AccessCode
    owner: AccessControl
    description: U1 の AccessCode の利用の拡張。kind が observer の行を、資格情報として受け付ける。列は足さない
    attributes: []
    relationships: []
    constraints:
      - kind が observer のコードは、ゲームが削除されるまで有効で、期限を持たない。強度は進行役用コードと同じ（暗号論的乱数による 128 ビット以上）。revokedAt が空であることを有効の条件とし、U4 は失効の操作を設けない
      - 観察者用コードで特定できるのは観察者だけで、参加者や進行役の権限は持たない

  - name: JoinAttemptWindow
    owner: AccessControl
    description: 接続元ごとの、無効な参加コードによる試行の数え。永続の実体ではない。保存先（メモリか PostgreSQL か）はインフラの設計の工程で決める
    attributes:
      - { name: source, type: string, required: true, constraints: "接続元の識別。信頼するプロキシの設定に従って得る" }
      - { name: failedAt, type: "timestamp の列", required: true, constraints: "直近 60 秒の無効な試行の時刻。窓から出た時刻は捨てる" }
    relationships: []
    constraints:
      - 数えるのは参加コードによる参加の無効な試行だけ。有効な参加は数えない
      - 拒否されている間の試行も数える（窓に加える）
      - 古い試行が 60 秒の窓から出れば、自動で解除される

  - name: ObserverView
    owner: AccessControl
    description: 観察者に返す投影。永続の実体ではない。GameStateView（契約 C1）の viewerKind が observer のときの形
    attributes:
      - { name: currentWeek, type: integer, required: true, min: 1, max: 50 }
      - { name: status, type: enum, required: true, allowed: [preparing, running, paused, ended] }
      - { name: inputsDone, type: integer, required: true, min: 0, max: 4, constraints: "入力済みの役割の数だけ。どの役割かは返さない" }
      - { name: teamWeeklyCost, type: integer, required: true, min: 0, constraints: "4 役割の費用の合計。整数の最小単位。最新の確定済みの週の値（currentWeek の週ではない）" }
      - { name: teamCumulativeCost, type: integer, required: true, min: 0, constraints: "4 役割の累積費用の合計" }
      - { name: teamInventory, type: integer, required: true, min: 0, constraints: "4 役割の週末在庫の合計。最新の確定済みの週の週末の値" }
      - { name: teamBacklog, type: integer, required: true, min: 0, constraints: "4 役割の週末受注残の合計。最新の確定済みの週の週末の値" }
    relationships: []
    constraints:
      - 役割別の在庫、受注残、意思決定値、受注、出荷、将来の需要、参加者の表示名、コード、token を含めない
      - 合計だけで、どの役割の値かを逆算できない
      - 確定済みの週がまだない（第 1 週の確定前）ときは、費用と在庫と受注残は初期状態の合計（費用は 0）を返す
```

## 実体の概要

| 実体 | 種類 | U4 での変更 |
| :--- | :--- | :--- |
| ReturnToken | 永続 | lastUsedAt の列を足す（移行） |
| AccessCode | 永続 | 変更なし。observer の行を資格情報として受け付ける |
| JoinAttemptWindow | 保存先は未定 | 新しく定める。接続元ごとの無効な試行の数え |
| ObserverView | 投影（保存しない） | 新しく定める。観察者に返す形 |

## 上流の資料

`components.md`、`unit-of-work.md`、`contract-summary.md`、`requirements.md`、`stories.md`、`functional-design-questions.md`
