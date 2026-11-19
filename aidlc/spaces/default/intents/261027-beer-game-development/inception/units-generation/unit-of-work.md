# Units of Work

## Unit catalogue

| Unit ID | Directory | Kind | Purpose | Deployment model | Complexity |
|---|---|---|---|---|---|
| U1 | `u1-walking-skeleton` | service | 1 ゲーム、4 役割、1 週確定、状態表示を real persistence まで接続する | modular monolith の最初の executable | XL |
| U2 | `u2-session-continuity` | service | 停止、代理入力、再接続、競合制御、復旧を追加する | 同じ application service へ組み込む module | L |
| U3 | `u3-learning-view` | service | 観察、終了後分析、version 付き export を追加する | 同じ application service の projection module | L |
| U4 | `u4-retention-operations` | service | 保持期限と cross-component deletion lifecycle を追加する | 同じ application service の background capability | M |
| U5 | `u5-accessible-experience` | ui | 全 flow の refined UI と WCAG 2.2 AA 対応を完成する | browser application | L |

## U1 - Walking Skeleton

### Boundaries

- `GameConfiguration`、`Participation`、`GameSession` の最小 capability と `SimulationEngine` library を含みます。
- 1 ゲーム作成、4 役割割当て、各役割の意思決定、1 週の原子的確定、役割別状態表示までを対象にします。
- 観察、終了後分析、export、retention automation は含みません。

### Responsibilities

- real database schema と transaction boundary を実装します。
- `SimulationEngine` を副作用のない library として実装し、既知系列の golden test を用意します。
- game/role authorization、idempotency、stale update 拒否を最小 flow で実装します。
- 最小 browser UI から end-to-end verification を実行可能にします。

### Constraints

- BDD の失敗する Given/When/Then を実装前に作成します。
- game state と outbox event は同じ transaction で永続化します。
- 役割別の非公開情報を API response に含めません。

## U2 - Session Continuity

### Boundaries

- U1 の session lifecycle を拡張し、停止、代理入力、再開、再接続、同時更新、障害復旧を扱います。
- 復帰 token の生成・digest 保存・失効と、複数 tab の stale state を対象にします。

### Responsibilities

- `Participation` の RecoveryCredential lifecycle を完成します。
- `GameSession` の pause / resume / end と proxy decision を実装します。
- audit、version conflict、restart recovery の BDD scenario を実装します。

## U3 - Learning View

### Boundaries

- `LearningView` の observation、review、export projection を実装します。
- U1 の outbox event を冪等かつ週順に consume し、再送と rebuild を可能にします。

### Responsibilities

- 逆算防止を含む privacy-safe observation projection を実装します。
- 終了後の時系列比較と schema-versioned CSV / JSON export を実装します。
- query / export authorization と partial failure 表示を実装します。

## U4 - Retention Operations

### Boundaries

- `GameConfiguration` が所有する retention policy と deletion saga を実装します。
- 各 component の所有 data を gameId 単位で冪等に削除し、PII を含まない deletion receipt を残します。

### Responsibilities

- retention scheduler、deletion request、component completion、retry を実装します。
- すべての対象 component 完了後だけ deletion を completed とします。
- 失敗と再試行を運営者が確認できる read model を提供します。

## U5 - Accessible Experience

### Boundaries

- U1〜U4 の capability を refined mockups に沿う browser UI として完成します。
- 1024 px 以上の desktop 操作、zoom reflow、keyboard、screen reader、非色依存表現を対象にします。

### Responsibilities

- game creation、lobby、play、facilitator、observation、review、export、retention status の画面を完成します。
- loading、empty、error、partial、stale、offline、paused、ended state を実装します。
- automated accessibility check と manual keyboard / screen reader test を追加します。

## Cross-unit constraints

- modular monolith の module boundary は Domain Design の component ownership と一致させます。
- cross-module data access は owner の application interface または contract を経由します。
- formatter、linter、type-check、test、coverage 80% floor を CI で検査します。
- deploy topology の分割は将来可能ですが、初回 release では network boundary を導入しません。

## Sources

- `aidlc/spaces/default/intents/261027-beer-game-development/inception/domain-design/components.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/domain-design/decisions.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/requirements-analysis/requirements.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/user-stories/stories.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/units-generation/units-generation-questions.md`

## Assumptions & Open Questions

- concrete technology stack と database product は後続 stage で決定します。
- U5 は capability の再実装ではなく、U1〜U4 の application contract を利用する UI scope です。

