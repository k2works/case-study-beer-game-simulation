# Security Design - U3 Learning View

## Trust boundaries

1. Fastify authentication resolves an opaque credential to a server-side actor context.
2. A U3 authorization port independently asks the Participation owner for current game membership/role and the GameSession owner for current status; path/body claims never grant access.
3. Query handlers select only allow-listed projection DTOs. Export status/download repeats authorization and scopes opaque references to actor, game, attempt, and 15-minute expiry.

## Defense in depth

- JSON Schema validates C3/C6 envelopes, identifiers, numeric bounds, and known schema major before domain handling.
- Observation policy computes a disclosure dependency graph over every returned aggregate. If contributor count <2 or any protected value can be solved from public equations, all implicated totals become `SUPPRESSED`.
- CSV output escapes formula-leading cells while canonical numeric values remain typed; JSON uses schema-versioned numeric fields.
- TLS 1.2+, HSTS, CSP, `nosniff`, restrictive referrer policy, same-site secure cookies, origin/CSRF validation for mutations.
- Structured logging uses an explicit allow-list and a redaction interceptor; export content and credentials never enter telemetry.
- Deletion requests immediately deny new reads/exports, delete U3 projections/packages idempotently, then emit C5 completion.

## Verification

Authorization matrix, IDOR, inverse-disclosure property tests, CSV injection, sensitive-log scans, deletion race tests, and contract fuzzing cover NFR3.1–NFR4.2.

## Sources

- `security-requirements.md`
- `contract-summary.md` C3–C6
