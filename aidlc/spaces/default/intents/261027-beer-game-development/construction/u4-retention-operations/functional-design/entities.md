# Entities - U4 Retention Operations

## Source of truth

```yaml
entities:
  - name: RetentionPolicy
    description: ゲーム記録を保持する期間と期限計算の規則
    attributes:
      - {name: gameId, logical_type: identifier, required: true, unique: true, references: GameDefinition}
      - {name: retentionDays, logical_type: integer, required: true, default: 90, min: 1}
      - {name: retentionStartsAt, logical_type: timestamp, required: true}
      - {name: deleteAfter, logical_type: timestamp, required: true}
      - {name: policyVersion, logical_type: integer, required: true, min: 1}
    constraints: [retentionDays defaults to 90, deleteAfter is derived from retentionStartsAt and retentionDays]
  - name: DeletionSaga
    description: game-scoped deletion を全 owner Unit にわたり調整する aggregate root
    attributes:
      - {name: deletionId, logical_type: identifier, required: true, unique: true}
      - {name: gameId, logical_type: identifier, required: true, unique: true, references: GameDefinition}
      - {name: status, logical_type: enum, required: true, allowed_values: [PENDING, IN_PROGRESS, FAILED, COMPLETED]}
      - {name: attempt, logical_type: integer, required: true, min: 1}
      - {name: requestedAt, logical_type: timestamp, required: true}
      - {name: lastFailureCode, logical_type: string, required: false}
    constraints: [one active saga per game, COMPLETED requires every required owner completion]
  - name: OwnerDeletionProgress
    description: owner Unit ごとの削除状態
    attributes:
      - {name: deletionId, logical_type: identifier, required: true, references: DeletionSaga}
      - {name: ownerUnit, logical_type: enum, required: true, allowed_values: [u1-walking-skeleton, u2-session-continuity, u3-learning-view]}
      - {name: status, logical_type: enum, required: true, allowed_values: [PENDING, COMPLETED, RETRYABLE_FAILURE, PERMANENT_FAILURE]}
      - {name: completedAt, logical_type: timestamp, required: false}
      - {name: failureCode, logical_type: string, required: false}
    constraints: [unique by deletionId and ownerUnit, duplicate completion is idempotent]
  - name: DeletionReceipt
    description: U4 が一元所有する PII 非保持の削除証跡
    attributes:
      - {name: deletionId, logical_type: identifier, required: true, unique: true, references: DeletionSaga}
      - {name: gameReferenceDigest, logical_type: digest, required: true}
      - {name: outcome, logical_type: enum, required: true, allowed_values: [COMPLETED, FAILED]}
      - {name: recordedAt, logical_type: timestamp, required: true}
      - {name: expiresAt, logical_type: timestamp, required: true}
      - {name: correlationId, logical_type: identifier, required: true}
    constraints: [contains no display name recovery token credential digest or deleted payload, expires one year after recording]
relationships:
  - {from: RetentionPolicy, to: GameDefinition, cardinality: one-to-one, direction: governs}
  - {from: DeletionSaga, to: RetentionPolicy, cardinality: many-to-one, direction: triggered-by}
  - {from: DeletionSaga, to: OwnerDeletionProgress, cardinality: one-to-many, direction: coordinates}
  - {from: DeletionSaga, to: DeletionReceipt, cardinality: one-to-one, direction: records}
```

## Summary

`DeletionSaga` が全体状態を所有し、各 owner Unit は自身のデータ削除結果だけを返します。`DeletionReceipt` は削除対象データを含めず、完了または手動対応が必要な失敗を 1 年間記録します。
