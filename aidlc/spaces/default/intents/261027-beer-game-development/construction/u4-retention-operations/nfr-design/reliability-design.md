# Reliability Design - U4 Retention Operations

## Durable saga and idempotency

- Saga、owner progress、attempt ledger、outbox、receipt は PostgreSQL に永続化します。
- C5 更新は `WHERE deletion_id = ? AND owner_unit = ? AND current_attempt = ? AND terminal = false` の条件付き更新と event inbox 一意制約を同一 transaction で行います。
- 全 required owner が COMPLETED かつ receipt insert が成功した transaction だけ Saga を COMPLETED にします。
- restart 後は DB の `next_attempt_at` と未完 progress から処理を再開します。

## Retry policy

最大 5 回は初回を含む total attempt とします。retryable は timeout、connection reset、429、500、502、503、504、temporary database / broker unavailable に限定します。validation、authorization、unknown schema、契約違反は permanent とします。

`delay = min(15m, 30s * 2^(attempt-1)) + full-jitter(0..base-delay)` とし、予定時刻を attempt ledger に記録します。5 回目失敗、permanent failure、契約違反は FAILED で停止し、DLQ と運営 alert を生成します。

## Failure domains and recovery

- owner queue / DLQ の bulkhead により障害を owner 単位に限定します。
- completed owner は immutable とし、manual retry は同じ deletionId の `attempt + 1` で未完 owner だけへ C4 を送信します。
- PostgreSQL は Multi-AZ、point-in-time recovery を使用し、SQS redrive は current attempt check を通します。
- health check は process readiness と DB / queue の deep telemetry を分離し、依存障害で全 instance を同時退避させません。

## SLO definition

SLI は rolling 30 日に `deleteAfter` が到来した全 Saga のうち 24 時間以内に COMPLETED となった割合です。運営者が理由と期限を記録して承認した legal/incident hold は母集団から除外せず、別 series として併記して error budget 判断時に明示します。目標は 99%、error budget は 1% です。

## Sources

- `nfr-requirements/reliability-requirements.md`
- `nfr-design-questions.md` Q1、Q2

## Assumptions & Open Questions

None.
