# Observability Design - U2 Session Continuity

## Signal architecture

Fastify request hook が correlationId を生成または検証し、application command、database span、outbox event、SSE delivery へ伝播します。OpenTelemetry-compatible trace context を使用し、metric label は bounded cardinality の actor type、action、result、route に限定します。

## Structured logging

log schema は timestamp、level、service、environment、correlationId、gameId、actorType、action、result、latencyMs、stateVersion、errorCode を持ちます。token、digest、cookie、display name、decision payload は allowlist serializer により除外します。security failure は存在判定を漏らさない generic code で記録します。

## Metrics and SLI/SLO

| Metric / SLI | Target | Dimensions |
|---|---|---|
| `continuity_command_duration_ms` | p95 500 ms、p99 1 s | action、result |
| `recovery_snapshot_duration_ms` | p95 1 s | result |
| `reconciliation_seconds` | 5 s 以内 | cause |
| `recovery_attempt_total` | failure ratio を監視 | result、reasonClass |
| `outbox_lag_seconds` | 30 s 未満 | eventType |
| `stale_conflict_total` | baseline deviation を監視 | action |
| `audit_sequence_violation_total` | 0 | violationType |

availability SLI は valid request のうち非 5xx response の割合、correctness SLI は state / audit / outbox invariant check 成功率とします。

## Alerts

- recovery failure ratio が 5 minutes で 20% を超え、かつ 20 attempts 以上なら 1 minute 以内に warning。
- outbox lag が 30 s を 2 consecutive evaluations 超えたら warning、120 s 超過で critical。
- restart 後の readiness failure が 5 minutes、または active session recovery synthetic check が 2 回連続失敗したら critical。
- audit sequence gap / duplicate、redaction invariant violation は 1 件で critical。

## Dashboards and runbook links

Continuity dashboard に command latency / error、recovery success、SSE reconnect、outbox lag、stale conflicts、database pool saturation を表示します。各 alert は correlationId 検索、affected game count、rollback / failover / replay 手順への runbook link を持ちます。

## Verification

CI で log redaction、metric emission、trace propagation、invariant detection を assertion します。staging で synthetic recovery と outbox lag injection を実行し、alert が 1 minute 以内に発火・解消することを確認します。

## Requirement coverage

NFR14.1〜NFR14.4、NFR10.1〜NFR10.3、NFR11.6、NFR11.7 をこの設計で満たします。

