# NFR Design Questions - u1-walking-skeleton

## Q1 Multi-instance live update

複数 Fastify instance 間で committed state を SSE client へどう配信しますか？

- A. PostgreSQL outbox + LISTEN/NOTIFY hint + version reconciliation
- B. Redis Pub/Sub + PostgreSQL outbox
- C. Single application instance only
- X. Other (please specify)

[Answer]: A. PostgreSQL outbox + LISTEN/NOTIFY hint + version reconciliation

## Q2 Browser credential boundary

browser で facilitator / participant credential をどこに保持しますか？

- A. HttpOnly Secure SameSite cookie
- B. In-memory JavaScript state
- C. localStorage
- X. Other (please specify)

[Answer]: A. HttpOnly Secure SameSite cookie

## Q3 RPO 0 database pattern

committed week の RPO 0 と RTO 15 minutes をどの database pattern で満たしますか？

- A. Managed PostgreSQL Multi-AZ synchronous standby + PITR
- B. Single PostgreSQL + WAL archive / PITR
- C. Application-level dual write
- X. Other (please specify)

[Answer]: A. Managed PostgreSQL Multi-AZ synchronous standby + PITR

## Sources

- `construction/u1-walking-skeleton/nfr-requirements/performance-requirements.md`
- `construction/u1-walking-skeleton/nfr-requirements/security-requirements.md`
- `construction/u1-walking-skeleton/nfr-requirements/scalability-requirements.md`
- `construction/u1-walking-skeleton/nfr-requirements/reliability-requirements.md`
- `construction/u1-walking-skeleton/nfr-requirements/observability-requirements.md`
- `construction/u1-walking-skeleton/nfr-requirements/tech-stack-decisions.md`
- `construction/u1-walking-skeleton/nfr-requirements/reviews/review-01.md`
- `construction/u1-walking-skeleton/functional-design/functional-spec.md`
- `inception/contract-design/contract-summary.md`

## Assumptions & Open Questions

- None.
