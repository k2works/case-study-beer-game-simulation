# Scalability Design - U4 Retention Operations

## Scaling model

- API と worker は stateless とし、worker は owner Unit ごとの SQS queue depth と oldest-message age で水平 scale します。
- 通常は各 owner worker 1、queue depth 10 超または oldest age 5 分超で scale-outし、最大 5 worker / owner とします。
- PostgreSQL は `deletion_saga(game_id, status)`、`owner_progress(deletion_id, owner_unit)`、`retention_policy(delete_after, game_id)` で index し、将来は `delete_after` 月単位 partition を可能にします。

## Isolation and backpressure

- message 単位で transaction を閉じ、1 game の retry delay は SQS visibility / delayed redelivery で隔離します。
- owner queue と DLQ を分離し、1 owner の障害が他 owner の consumer capacity を消費しない bulkhead とします。
- database pool は process ごとに上限を持ち、全 instance 合計が DB connection budget を超えないよう auto-scaling 上限と連動します。

## Capacity thresholds

23 concurrent due games を基準に 2 倍 headroom を確保します。queue oldest age 15 分または DB pool saturation 80% が 10 分継続した場合は scale / capacity alert を発火します。

## Sources

- `nfr-requirements/scalability-requirements.md`
- `tech-stack-decisions.md`

## Assumptions & Open Questions

None.
