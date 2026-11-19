# Architecture Decision Records - Domain Design

## ADR-001: 週次計算を pure SimulationEngine に分離する

### Context

週確定は永続化、冪等性、認可を伴う一方、在庫・受注残・遅延・費用計算は同じ入力から同じ結果を返す必要があります。walking skeleton では UI、application、計算、永続化を接続しつつ、計算規則を golden test で保護します。

### Decision

GameSession が transaction と進行状態を所有し、状態と 4 役割の意思決定を pure な SimulationEngine へ渡します。SimulationEngine は外部依存を持ちません。

### Consequences

- Positive: 計算を高速な Unit Test と既知系列の golden test で検証できます。
- Positive: 永続化方式を変更しても計算規則を維持できます。
- Negative: GameSession と SimulationEngine 間の input / result contract が必要です。
- Neutral: 丸め、数量上限、需要 preset の詳細は後続設計で確定します。

### Alternatives Rejected

- GameSession への統合：初期実装は単純ですが、transaction と domain calculation が密結合します。
- 在庫・注文・配送・費用ごとの component：週確定 invariant が複数境界に分散し、現規模では複雑すぎます。

## ADR-002: account なしの参加情報を Participation が所有する

### Context

利用者は login account を作らず、参加コードと表示名で参加し、browser 保存の復帰 token で同じ役割へ戻ります。全 command と query でゲーム・役割権限を server 側で検査する必要があります。

### Decision

Participation が Participant、RoleAssignment、RecoveryCredential を一意に所有し、GameSession へ authorization identity を提供します。

### Consequences

- Positive: 個人情報を表示名に限定し、credential lifecycle を game calculation から分離できます。
- Positive: 役割割当てと同一役割の共同参加を 1 箇所で管理できます。
- Negative: GameSession command ごとに Participation との権限確認が必要です。
- Neutral: credential の具体的な生成、保存、rotation は NFR Design で決めます。

### Alternatives Rejected

- GameSession が参加情報も所有：session aggregate が identity、進行、計算を抱えて肥大化します。
- 汎用 Identity component：account、password、profile など対象外の概念を持ち込みます。

## ADR-003: 学習用表示を event-driven read model とする

### Context

プレイ中は役割別の非公開情報を守り、観察者へ逆算不能な合計だけを公開します。終了後は全役割の時系列を比較し、CSV / JSON を生成します。同じ write model の直接公開は情報漏洩につながります。

### Decision

LearningView が GameSession の commit 済み domain event を受け、ObservationProjection、ReviewProjection、ExportPackage を用途別に所有します。

### Consequences

- Positive: 情報開示規則を projection 作成時に強制できます。
- Positive: 分析 query と export が週確定 transaction の性能へ直接影響しません。
- Negative: event 配送と read model 更新には eventual consistency と再構築の考慮が必要です。
- Neutral: 画面更新は 2 秒以内という NFR の範囲で lag を許容します。

### Alternatives Rejected

- GameSession entity の直接参照：各 consumer が masking を実装し、漏洩 risk が増えます。
- 観察、振り返り、export の 3 component：現時点では同じ event と時系列 projection を共有し、分割 cost が価値を上回ります。

## ADR-004: retention を GameConfiguration の lifecycle とする

### Context

保持期間はゲーム作成時に設定され、期限後は game record、audit、recovery credential、projection を一貫して削除する必要があります。各 component は自身の entity を所有するため、1 component が他 component の storage を直接削除できません。

### Decision

GameConfiguration が retention policy と deletion lifecycle を所有し、期限到達時に gameId 単位の削除要求を発行します。各所有 component は冪等に自身の data を削除し、GameConfiguration は全結果が成功した場合だけ完了状態を記録します。

### Consequences

- Positive: retention policy の正本と削除完了判定が 1 箇所になります。
- Positive: 各 component の entity ownership を崩しません。
- Negative: 複数 component にまたがる saga と retry が必要です。
- Neutral: 物理削除、tombstone、監査 evidence の保持範囲は NFR Design で詰めます。

### Alternatives Rejected

- GameConfiguration が全 storage を直接削除：entity ownership と component encapsulation を破ります。
- 各 component が独自 schedule で削除：完了状態と失敗再試行を一貫して観測できません。

## Sources

- `components.md`
- `domain-design-questions.md`
- `requirements.md`
- `stories.md`
- `team-practices.md`

## Assumptions & Open Questions

- event delivery の保証と deletion saga の timeout は NFR Design で決定します。

