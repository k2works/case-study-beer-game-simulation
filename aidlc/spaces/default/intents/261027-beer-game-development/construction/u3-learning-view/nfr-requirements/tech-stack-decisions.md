# Tech Stack Decisions - U3 Learning View

## Decisions

| Area | Selection | Rationale |
|---|---|---|
| Runtime/API | TypeScript on Node.js 22 in the existing Fastify modular monolith | Aligns with U1/U2 and preserves module ownership. |
| Persistence | PostgreSQL projections plus transactional consumer cursor | Atomic updates, indexed reads, durable rebuild state. |
| Events | Transactional outbox dispatcher and session-partitioned consumer port | At-least-once, ordering, idempotency, replaceable broker. |
| Validation | JSON Schema / TypeBox-compatible C3/C6 fixtures | Contract linting and generated API compatibility. |
| Export | Streaming CSV and JSON from one immutable dataset snapshot | Bounded memory and cross-format equality. |
| Tests | Vitest, Playwright, contract fixtures, fault injection | BDD and ≥80% line coverage. |
| Telemetry | OpenTelemetry-compatible signals and structured JSON logs | Cross-path correlation without backend lock-in. |

No cache is required at 15-team scale. Broker/backend selection remains for infrastructure design.

## Quality requirements

| ID | Requirement |
|---|---|
| NFR5.1 | U3 UI consumers are keyboard operable, do not rely on color, and meet WCAG 2.2 AA contrast. |
| NFR6.1 | C6 and export flows support the latest two desktop Chrome, Edge, Firefox, and Safari versions. |
| NFR8.1 | Given/When/Then precedes implementation; unit, integration, contract, browser tests run in CI at ≥80% line coverage. |
| NFR9.1 | Checks run on `develop`; `main` deploys staging automatically and production requires manual approval. |

## Sources

- `technology-stack.md`
- `requirements.md` NFR5, NFR6, NFR8, NFR9
