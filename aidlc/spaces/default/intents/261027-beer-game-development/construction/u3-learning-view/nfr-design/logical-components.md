# Logical Components - U3 Learning View

## Inventory

| Component | Responsibility | Failure domain | Shared resource |
|---|---|---|---|
| Learning API Adapter | C6 HTTP validation and DTO serialization | HTTP instance | Fastify process |
| Authorization Gateway | Fresh membership/status verification | U1/U2 dependency | credential context |
| Projection Consumer | C3 validation, ordering, idempotent projection | session partition | PostgreSQL |
| Disclosure Policy | allow-list and inverse-disclosure suppression | in-process request/event | none |
| Projection Repository | atomic rows, event marker, cursor, rebuild state | PostgreSQL transaction | PostgreSQL |
| Rebuild Coordinator | replay/snapshot recovery and shadow swap | one session | durable queue |
| Export Coordinator | immutable snapshot and job lifecycle | one export attempt | durable queue |
| Export Worker | streaming generation and validation | worker bulkhead | object/artifact store |
| Telemetry Adapter | allow-listed signals and SLO metrics | telemetry backend | OpenTelemetry collector |
| Deletion Consumer | U3 deletion and C5 completion | one game | PostgreSQL/artifact store |

## Boundaries

U3 remains one deployable modular-monolith slice. Ports isolate authorization, replay/snapshot, queue, artifact storage, and telemetry so infrastructure choices do not enter domain policy.

## Sources

- All U3 NFR requirement artifacts
- `functional-spec.md`
