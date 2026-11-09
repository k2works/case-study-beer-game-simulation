# Business Rules - U4 Retention Operations

## Source of truth

```yaml
rules:
  - id: BR15.1
    statement: retentionDays 未設定時は 90 日を適用する
    category: policy
    applies_to: RetentionPolicy
    trigger: game creation
    logic: IF retentionDays is absent THEN set it to 90
    violation: reject a policy that has no resolvable retention period
    source: FR8.1, AC5.1.1
  - id: BR15.2
    statement: 保持期限到達時は game ごとに 1 つの deletion saga を開始する
    category: constraint
    applies_to: DeletionSaga
    trigger: retention scheduler scan
    logic: IF deleteAfter is due and no active saga exists THEN create one saga and publish C4
    violation: duplicate requests resolve to the existing deletionId
    source: FR8.2, AC5.1.2
  - id: BR15.3
    statement: 各 owner Unit は自身が所有するデータだけを gameId 単位で冪等に削除する
    category: authorization
    applies_to: OwnerDeletionProgress
    trigger: C4 DeletionRequested
    logic: IF the same deletionId is redelivered THEN return the same completed outcome without accessing another owner's data
    violation: emit retryable-failure or permanent-failure without deleted payload
    source: FR8.2, AC5.1.2
  - id: BR15.4
    statement: 全 required owner が completed を返すまで saga を COMPLETED にしない
    category: constraint
    applies_to: DeletionSaga
    trigger: C5 DeletionCompleted
    logic: IF every required owner is COMPLETED THEN record receipt and complete ELSE remain in progress or failed
    violation: partial deletion is never presented as complete
    source: FR8.3, AC5.1.3
  - id: BR15.5
    statement: retryable failure は同じ deletionId と増加した attempt で有限 backoff 再試行する
    category: policy
    applies_to: DeletionSaga
    trigger: retryable-failure or timeout
    logic: IF retry budget remains THEN republish C4 for incomplete owners only
    violation: exhausted retries transition to FAILED for operator action
    source: FR8.3, AC5.1.3
  - id: BR15.6
    statement: permanent failure は FAILED で停止し運営者の明示的な再試行を必要とする
    category: policy
    applies_to: DeletionSaga
    trigger: permanent-failure
    logic: IF any owner reports permanent-failure THEN stop automatic retries and require operator resolution
    violation: never mark PARTIAL_COMPLETE or COMPLETED
    source: FR8.3, AC5.1.3
  - id: BR15.7
    statement: U4 は PII を含まない deletion receipt を一元所有し記録後 1 年で削除する
    category: policy
    applies_to: DeletionReceipt
    trigger: saga completion or terminal failure
    logic: IF receipt is recorded THEN exclude personal and deleted content and set expiresAt to one year
    violation: reject and alert on prohibited receipt fields
    source: FR8.2, NFR4, AC5.1.2
```

## Rules summary

| Rule | Summary |
|---|---|
| BR15.1 | 既定 90 日の保持期限 |
| BR15.2〜BR15.3 | 単一 Saga と owner 単位の冪等削除 |
| BR15.4〜BR15.6 | 完了条件、有限 retry、恒久障害の手動対応 |
| BR15.7 | PII 非保持 receipt の U4 一元所有と 1 年保持 |
