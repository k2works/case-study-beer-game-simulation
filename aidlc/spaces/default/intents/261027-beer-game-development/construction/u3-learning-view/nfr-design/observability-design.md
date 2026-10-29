# Observability Design - U3 Learning View

## Telemetry

- OpenTelemetry context propagates `correlationId`; async spans link `eventId` rather than copying payloads.
- JSON logs contain operation, result, hashed session identifier, versions, duration, retry, and failure code through an allow-list serializer.
- Prometheus-compatible metrics implement C6 RED signals plus consumer lag/gaps/duplicates, rebuilds, export queue/duration/failure, and suppression counts.

## SLO and alerts

- Availability SLO: 99.9% monthly, with 1-hour and 6-hour burn-rate alerts.
- Alert thresholds match NFR7.4 and route privacy/schema failures immediately; latency/queue alerts route during service hours unless error-budget burn is fast.
- Dashboards: API SLO, projection health, exports, and privacy controls. Every alert links a replay/rebuild, export cleanup, authorization, or schema runbook.

## Sources

- `observability-requirements.md`
