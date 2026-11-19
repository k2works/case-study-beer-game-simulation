# Entities - U2 Session Continuity

## Aggregate extensions

### GameSession

- `status`: `RUNNING | PAUSED | ENDED`
- `stateVersion`: 単調増加する optimistic concurrency token
- `lastCommittedWeek`: 復旧基点となる確定済み週
- pause / resume / end は facilitator credential のみ許可し、各遷移を audit と outbox に同一 transaction で記録します。

### Participation

- `participantId`、`gameId`、`roleId`、`credentialDigest`、`credentialExpiresAt`、`revokedAt`
- raw recovery token は永続化せず、256-bit token の digest のみを保存します。
- role membership は token ではなく Participation が所有し、再接続時に server-side membership を再評価します。

### DecisionDraft

- `gameId`、`week`、`roleId`、`quantity`、`version`、`updatedBy`、`updatedAt`
- participant 入力と facilitator proxy input を同じ record で表し、`updatedBy` に actor type / actor id を保持します。

### AuditEntry

- `auditId`、`gameId`、`eventSequence`、`actorType`、`actorId`、`action`、`roleId?`、`occurredAt`、`metadata`
- proxy decision は操作者、対象 role、変更前後、理由、時刻を記録します。credential や raw token は含めません。

## Ownership and invariants

- GameSession が lifecycle と stateVersion を所有します。
- Participation が recovery credential lifecycle と role membership を所有します。
- committed week は不変で、pause / reconnect / restart により巻き戻しません。
- 同じ `eventSequence` は game 内で一意です。

## Sources

- `inception/units-generation/unit-of-work.md` U2
- `inception/user-stories/stories.md` US3.1、US3.2
- `inception/domain-design/components.md`
- `inception/contract-design/contract-summary.md`

## Assumptions & Open Questions

- Recovery token の標準有効期限は game 終了 24 hours 後までとします。
