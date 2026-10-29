# Reliability Design - U2 Session Continuity

## Transaction boundary

GameSession の state change、credential rotation、idempotency result、AuditEntry、outbox event は同一 PostgreSQL transaction で commit します。aggregate row の version を compare-and-update し、0 rows updated は stale conflict として扱います。commit に失敗した場合はすべて rollback し、HTTP success を返しません。

## Retry and idempotency

- client mutation は idempotency key を必須とし、同じ scope + key + request hash の retry には同じ status と result reference を返します。
- database serialization / transient connection failure は transaction 全体を最大 3 回、100 / 250 / 500 ms + jitter で再試行します。validation、authorization、version conflict は再試行しません。
- outbox dispatcher は at-least-once delivery とし、eventId で重複排除します。30 s 超過の lag は alert、10 retries 超過は隔離 queue 相当の status へ移します。

## Restart and recovery

起動時に migration compatibility、database connectivity、outbox backlog を確認します。instance-local cache を authority にせず、active session は request 時に PostgreSQL から lazy restore します。全 active session の availability は application restart 後 15 minutes 以内、個別 reconnect は NFR10.2 の 1 s target を満たします。

## Graceful degradation

- SSE failure: polling fallback と snapshot reconciliation を提供します。
- outbox backlog: state mutation は durable outbox commit まで受理し、配信遅延を表示・監視します。
- database unavailable: mutation は `503` と retry guidance を返し、memory-only write は行いません。
- paused session: participant mutation を `409 SESSION_PAUSED` で拒否し、既存 draft を変更しません。

## Health and recovery objectives

readiness は database query と migration compatibility、liveness は event-loop responsiveness を検査します。committed lifecycle / week / proxy decision の RPO は 0 です。PostgreSQL backup、PITR、Multi-AZ failover、restore drill の具体構成は Infrastructure Design へ引き渡します。

## Verification

container-backed PostgreSQL で process kill、commit failure、serialization conflict、outbox replay、duplicate idempotency key、multi-tab stale version、draft preservation を fault-injection test します。

## Requirement coverage

NFR13.1〜NFR13.5、NFR12.3、NFR10.3 をこの設計で満たします。

