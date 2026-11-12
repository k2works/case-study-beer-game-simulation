# 契約の一覧（Contract Summary）

beer-game3 の境界で守る約束を、5 つに整理しました。6 つの Unit（`unit-of-work.md`）は 1 つのアプリケーションにまとめてデプロイするため（`unit-of-work-dependency.md` の接点）、Unit 間の境界の多くは、通信ではなく、アプリ内の公開インターフェースと共有のデータベーススキーマです。ブラウザから呼ぶ API だけが、アプリの外に出る境界です。

部品の形は `components.md`、数値の条件は `requirements.md` に従います。

## 回答の要約

| 質問 | 決定 |
| :--- | :--- |
| Q1 API の形式 | REST と JSON。OpenAPI で仕様を書く |
| Q2 画面への反映 | ポーリング。画面が数秒おきに状態を取り直す |
| Q3 Unit 間の境界 | アプリ内の型付きの公開インターフェースと、共有のデータベーススキーマ。U1 が土台を持ち、後続が移行を足す |
| Q4 変更の取り決め | 追加は後方互換。削除と意味の変更は、同じ変更の中で使う側も直す。版番号は付けない |
| Q5 失敗と再送 | 共通のエラー形式を 1 つ定める。入力と週確定は、利用者が付ける識別子で冪等にする |

## 契約の表

| # | Provider Unit | Consumer | Mechanism | Owner |
| :--- | :--- | :--- | :--- | :--- |
| C1 | U1（U2〜U5 が入口を足す） | External: 自分たちのブラウザ画面 | REST と JSON（OpenAPI） | 入口を実装する Unit。共通の部分（認証、エラー形式、冪等性）は U1 |
| C2 | U1（SimulationEngine） | U1（GameSession）、U2 | アプリ内の公開インターフェース（共有スキーマ） | U1 |
| C3 | U1（GameSession と保存） | U2、U3、U4、U5 | アプリ内の公開インターフェースと共有のデータベーススキーマ | U1（土台）。移行は足した Unit |
| C4 | U1（AccessControl の最小の形） | U3、U4、U5 | アプリ内の公開インターフェース（共有スキーマ） | U1（最小の形）。U4 が仕上げる |
| C5 | U3（ゲームの終了） | U5（Retention、Reporting） | アプリ内の公開インターフェースと共有のデータベーススキーマ | U3 |

## C1 ブラウザから呼ぶ API

提供: U1 が土台、U2〜U5 が入口を足す。使う側: 自分たちの画面（外部の利用者は想定しない）。

- 呼び出す人の判定は、毎回の要求に付ける資格情報（参加者の token、進行役用コード、観察者用コード）で行う。応答は、判定した人ごとの投影だけを返す（FR4.1、ADR-002）。他役割の在庫、受注残、意思決定値、将来の需要は、応答に含めない。
- 入力と週確定は、利用者が付ける識別子（`Idempotency-Key` ヘッダ）で冪等にする。同じ識別子の再送には、前回と同じ結果を返す（FR7.3、FR9.1）。
- 状態は、画面が数秒おきに取り直す（ポーリング）。再接続後の復帰も、同じ状態の取得で済む。
- エラーは共通の形式で返す。種類、理由、直し方を持つ。

```yaml
openapi: 3.1.0
info:
  title: beer-game3 API
  version: "0"
  description: ブラウザ画面が呼ぶ API。版番号は付けない。追加は後方互換、削除と意味の変更は同じ変更の中で使う側も直す
servers:
  - url: /api
security:
  - gameCredential: []
components:
  securitySchemes:
    gameCredential:
      type: http
      scheme: bearer
      description: 参加者の token、進行役用コード、観察者用コードのいずれか。サーバー側で種類を判定する
  parameters:
    idempotencyKey:
      name: Idempotency-Key
      in: header
      required: true
      schema: { type: string, minLength: 16, maxLength: 128 }
      description: 利用者が付ける識別子。同じ識別子の再送には前回と同じ結果を返す
  schemas:
    Problem:
      type: object
      required: [kind, reason, hint]
      properties:
        kind:
          type: string
          enum: [validation, forbidden, not_found, conflict, state, rate_limited, unavailable, internal]
        reason: { type: string, description: 日本語の理由 }
        hint: { type: string, description: 日本語の直し方 }
        missingRoles:
          type: array
          items: { type: string, enum: [factory, wholesaler1, wholesaler2, retailer] }
    Role:
      type: string
      enum: [factory, wholesaler1, wholesaler2, retailer]
    GameStateView:
      type: object
      description: 呼び出した人ごとの投影。参加者には自分の役割だけを返す
      required: [gameId, status, currentWeek, setupKind, viewerKind]
      properties:
        gameId: { type: string }
        status: { type: string, enum: [preparing, running, paused, ended] }
        currentWeek: { type: integer, minimum: 1, maximum: 50 }
        setupKind: { type: string, enum: [kit, custom] }
        viewerKind: { type: string, enum: [participant, facilitator, observer] }
        role: { $ref: "#/components/schemas/Role" }
        mine:
          type: object
          description: 参加者の自分の役割の状態（在庫、受注残、入荷、受注、履歴、入力済みの値）
        inputsDone: { type: integer, minimum: 0, maximum: 4, description: 参加者には入力済みの数だけ返す }
paths:
  /games:
    post:
      summary: ゲームを作成する（進行役）。参加コード、進行役用コード、観察者用コードを発行する
      security: []
      responses:
        "201": { description: 作成した }
        "422": { description: 設定が範囲外または長さ不一致, content: { application/json: { schema: { $ref: "#/components/schemas/Problem" } } } }
  /games/join:
    post:
      summary: 参加コードと表示名で参加する。参加者の token を返す
      security: []
      responses:
        "201": { description: 参加した }
        "409": { description: 終了済み、または進行中のため参加できない }
        "429": { description: 無効なコードの試行が上限を超えた }
  /games/{gameId}/assignments/{participantId}:
    put:
      summary: 準備中に、役割を割り当てる、付け替える、未割当てに戻す（進行役）。進行中と一時停止中の入れ替えは replacement を使う
      responses:
        "200": { description: 割り当てた }
        "409": { description: 進行中と一時停止中は常に拒否する（state。入れ替えには replacement を使うよう案内）。定員（1 役割 4 人）を超える割当ても拒否する }
  /games/{gameId}/roles/{role}/replacement:
    post:
      summary: 進行中または一時停止中に、その役割の担当者 1 人を新しい 1 人に入れ替える（進行役）。旧担当者の識別子と新しい担当者の表示名を受け、新しい参加者と復帰用 token（平文は一度だけ、Cache-Control no-store）を返す。Idempotency-Key は使わない
      responses:
        "201": { description: 入れ替えた。旧担当者の token は失効する }
        "403": { description: 進行役用コードでない }
        "409": { description: 状態が進行中・一時停止中でない（state）、または旧担当者がその役割の担当者でない・すでに入れ替え済み（conflict） }
        "422": { description: 表示名が空または 40 文字超、識別子が不正 }
  /games/{gameId}/start:
    post:
      summary: ゲームを開始する（進行役）。4 役割がそろっていなければ拒否し、未割当ての役割を示す
      responses:
        "200": { description: 開始した }
        "409": { description: 未割当ての役割がある }
  /games/{gameId}/weeks/{week}/decisions/{role}:
    put:
      summary: 発注数または生産要請数を入力する。非負の整数のみ
      parameters:
        - { $ref: "#/components/parameters/idempotencyKey" }
      responses:
        "200": { description: 保存した。確定前は何度でも上書きできる }
        "422": { description: 整数でない、または負数 }
        "409": { description: 一時停止中または終了後 }
  /games/{gameId}/weeks/{week}/confirm:
    post:
      summary: 週を確定する（進行役）。4 役割の入力がそろったときだけ、一度だけ、原子的に行う
      parameters:
        - { $ref: "#/components/parameters/idempotencyKey" }
      responses:
        "200": { description: 確定した。再送には前回と同じ結果を返す }
        "409": { description: 未入力の役割がある }
  /games/{gameId}/state:
    get:
      summary: 呼び出した人ごとの投影で、現在の状態を返す（画面が数秒おきに取り直す）
      responses:
        "200": { description: 状態, content: { application/json: { schema: { $ref: "#/components/schemas/GameStateView" } } } }
        "403": { description: 権限がない }
  /games/{gameId}/pause:
    post: { summary: 一時停止する（進行役）, responses: { "200": { description: 一時停止した } } }
  /games/{gameId}/resume:
    post: { summary: 再開する（進行役）, responses: { "200": { description: 再開した } } }
  /games/{gameId}/end:
    post:
      summary: 終了する（進行役）。終了の理由は facilitator に固定し、本文の reason は受け取らない
      responses:
        "200": { description: 終了した。終了済みのゲームには、何も変えず現在の状態を返す（冪等） }
        "409": { description: 準備中のゲームは終了できない（state。準備中からの終了は U5 の自動終了だけ） }
  /games/{gameId}/history:
    get:
      summary: 操作の履歴を sequence の昇順で全件返す（進行役）。7 種類（setting、roleChange、proxyInput、weekConfirm、pause、resume、end）
      responses:
        "200": { description: "{ entries: [{ sequence, kind, actorKind, occurredAt, week, role, detail }] }。資格情報の平文は含まない" }
        "403": { description: 進行役用コードでない }
  /games/{gameId}/results:
    get:
      summary: 終了後の全役割の時系列を返す。プレイ中は開示しない
      responses:
        "200": { description: 時系列 }
        "403": { description: 終了前は他役割の時系列を開示しない }
  /games/{gameId}/export:
    get:
      summary: ゲーム設定と全週の記録を出力する（進行役）
      parameters:
        - { name: format, in: query, required: true, schema: { type: string, enum: [csv, json] } }
      responses:
        "200": { description: 出力。CSV と JSON で同じ数値になる }
```

U1 は参加、割当て、開始、入力、確定、状態の取得を持つ。U3 は一時停止、再開、終了、担当者の入れ替え、代理入力、進行管理の入口を足す。U4 は観察者の入口と、復帰用 token の再接続を足す。U5 は結果と出力の入口を足す。

## C2 SimulationEngine の入力と出力

提供: U1。使う側: U1 の GameSession、U2（既知系列の試験）。副作用がなく、時計、乱数、保存、通信に触れない（ADR-006）。

```yaml shared-schema
SimulationEngine.computeWeek:
  input:
    settings: { weekCount: int, inventoryUnitCost: int, backlogUnitCost: int }  # 金額は整数の最小単位
    state:
      week: int
      roles:                       # 4 役割それぞれ
        inventory: int
        backlog: int
        deliveryPipeline: [int, int]   # 配送の遅延の枠（2 週）
        orderPipeline: [int, int]      # 注文情報の遅延の枠（2 週）
        productionPipeline: [int, int] # 工場のみ（2 段階）
    customerDemand: int                # 当週の小売店への需要
    decisions: { factory: int, wholesaler1: int, wholesaler2: int, retailer: int }  # 非負の整数
  output:
    state: 同じ形。次の週の状態
    perRole:
      receipt: int
      ordersReceived: int
      shipped: int
      inventory: int           # max(0, 利用可能量 - 充足対象)
      backlog: int             # max(0, 充足対象 - 利用可能量)
      weeklyCost: int          # 在庫 × 在庫単価 + 受注残 × 受注残単価
  guarantees:
    - 同じ入力からは常に同じ出力を返す
    - 負の在庫と負の受注残を返さない
    - 遅延の週数は固定で、設定では変えられない
```

エラー: 入力が不正（負数、役割の欠け）のときは、例外ではなく型の違反として扱い、呼び出し側（GameSession）が事前に検証する。

## C3 GameSession の集約と共有スキーマ

提供: U1。使う側: U2、U3、U4、U5。ゲーム全体を 1 つの集約として扱い、1 回の保存で更新する（ADR-003、ADR-004）。

```yaml shared-schema
GameSession:
  load: (gameId) -> Game            # 集約を読み直す。復元（FR12）はこれだけで済む
  save: (game, expectedVersion) -> Game   # 1 回の保存で更新する。版が違えば衝突として拒否する
  commands:                          # 結果として履歴を同じ保存の中で残す
    create: (settings) -> Game
    join: (displayName) -> Participant
    assignRole: (participantId, role)
    start: ()
    submitDecision: (week, role, quantity, idempotencyKey)
    confirmWeek: (week, idempotencyKey) -> WeekResult
  storage:
    engine: PostgreSQL
    ownership:
      U1: [games, game_settings, demand_series, participants, role_assignments, week_records, pipeline_slots, access_codes, return_tokens（基本の列）, idempotency_records]
      U3: [operation_log_entries]
      U4: [return_tokens への有効期間と最後の操作の時刻の列の追加]
      U5: [retention_policies]
    migration: 後続の Unit は、自分が足す表を別の移行として足す。既存の表の列の削除や意味の変更は、同じ変更の中で使う側も直す
    concurrency: 同じゲームへの書き込みは 1 つずつ順に処理する（U1 の Functional Design の決定）。それでも保存の版の検査は安全装置として残し、版が食い違う保存は拒否する
```

履歴の表は U3 が足すが、操作と同じ保存の中で書く（ADR-004）。U1 の保存は、履歴を後から同じ保存の中へ足せる形にする。

## C4 AccessControl の判定と投影

提供: U1（最小の形）。使う側: U3、U4、U5。GameSession を直接公開せず、外へ出る経路をここに限る（ADR-002）。

```yaml shared-schema
AccessControl:
  authenticate: (credential) -> Principal
    # Principal: { kind: participant | facilitator | observer, gameId, role? , participantId? }
    # 無効な資格情報は forbidden。無効なコードの試行は接続元ごとに数え、上限を超えたら rate_limited
  authorize: (principal, action) -> allow | deny
    # 進行役の操作は進行役用コードを持つ人だけ。観察者は入力できない
  project: (game, principal) -> GameStateView
    # 参加者: 自分の役割の情報だけ。小売店だけが当週までの顧客需要
    # 進行役: 全役割の状態。観察者: チーム全体の集計値だけ
    # 終了後: 全役割の時系列を開示する
  issue: (kind) -> code | token       # 暗号論的乱数で発行。参加コードは 8 文字以上、進行役用コードと token は 128 ビット以上
```

U1 が最小の形（参加コードと進行役用コード、参加者を特定する token、自分の役割だけの投影）を持つ。U4 が観察者用コード、有効期間、失効、試行回数の制限、小売店だけの需要の投影を足す。

## C5 ゲームの終了と削除

提供: U3（終了の状態遷移）。使う側: U5（Reporting は終了したゲームを読み、Retention は終了と削除を依頼する）。

```yaml shared-schema
GameLifecycle:
  end: (gameId, reason: facilitator | finalWeek | autoEnd) -> Game
    # 終了週の確定で自動終了する。終了から保持期間を数える
  delete: (gameId)
    # ゲームの集約と、参加コード、復帰用 token を、同じ保存の中で削除する
  query:
    endedGames: () -> [gameId, endedAt]       # 保持期限の判定に使う
    staleRunningGames: () -> [gameId, lastOperationAt]   # 最後の操作から 30 日の自動終了に使う
```

## 契約の所有の規則

- 仕様は、提供する Unit が持つ。入口は、実装する Unit が自分の OpenAPI の部分を持つ。
- 追加は後方互換にする。使う側は、未知の項目を無視する。
- 削除と意味の変更は、同じ変更の中で使う側もすべて直す。画面と API は同時に配信されるため、並行して古い形を維持しない。
- データベースの表は、足した Unit が別の移行として足す。
- 失敗の形（`Problem`）と冪等性（`Idempotency-Key`）は、U1 が土台を持ち、すべての入口が従う。

## 失敗、時間切れ、再送

| 境界 | 失敗の扱い | 時間切れ | 再送 |
| :--- | :--- | :--- | :--- |
| C1 入力と週確定 | `Problem` で返す。部分更新を残さない | 画面が状態を取り直して確かめる。サーバーは自動で再試行しない | `Idempotency-Key` が同じなら前回と同じ結果 |
| C1 状態の取得 | `Problem` で返す | 画面が次の周期で取り直す | 読み取りのため重複の影響はない |
| C2 計算 | 事前に GameSession が検証する | 同期の計算で、時間切れはない | 同じ入力は同じ出力 |
| C3 保存 | 版が違えば衝突として拒否する | 保存に失敗したときは確定前の状態に戻る（FR9.2） | 識別子と版で重複を防ぐ |

## 未確定の点

| Contract | Question | Blocks |
| :--- | :--- | :--- |
| C5 | 削除の対象に、AccessControl の表（参加コード、復帰用 token）を含める。U4 が U5 より後に完成した場合の扱い | U4、U5 |
| C1 | ポーリングの周期（数秒）の具体値。週確定後 2 秒以内の反映（NFR3、仮の値）との関係 | U1、U6 |
| C1 | 発注数・生産要請数の上限（`requirements.md` の未確定事項） | U1 |

## 上流の資料

`unit-of-work.md`、`unit-of-work-dependency.md`、`components.md`、`requirements.md`
