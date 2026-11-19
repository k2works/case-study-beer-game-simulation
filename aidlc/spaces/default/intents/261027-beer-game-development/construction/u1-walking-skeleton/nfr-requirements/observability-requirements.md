# Observability Requirements - u1-walking-skeleton

## Logs and Traces

| ID | Requirement | Verification |
|---|---|---|
| NFR7.1 | game create、join、role assignment、session start、decision submit、week commit を structured audit event として記録する。 | audit schema test |
| NFR7.2 | HTTP request、database transaction、outbox event、SSE delivery に同じ correlation ID を伝播する。 | trace propagation integration test |
| NFR7.3 | log / trace / metric label に raw token、credential digest、display name、future demand、role-private quantity を含めない。 | automated sensitive-data scan |
| NFR7.4 | API latency、error rate、commit conflict、transaction rollback、outbox lag、SSE delivery lag、active connection を operation / outcome 別に計測する。 | metric contract test |

## SLI and Alerts

| ID | SLI / Alert | Threshold |
|---|---|---|
| NFR7.5 | Availability SLI | successful eligible requests / total eligible requests; monthly target 99.5% |
| NFR7.6 | Active-session outage | no successful health / critical operation for 1 minute during declared session window |
| NFR7.7 | Performance burn | API p95 > 1 second or state reflection p95 > 2 seconds for 5 minutes |
| NFR7.8 | Correctness risk | any duplicate week result, invariant violation, or committed transaction without matching outbox event |
| NFR7.9 | Delivery lag | outbox or SSE lag p95 > 1 second for 5 minutes |

## Dashboard

- request volume / latency / error、active game / SSE connection、week commit success / conflict / rollback、database transaction、outbox lag、SLO burn を 1 dashboard に表示します。
- alert は correlation ID、game の opaque ID、operation、first observed time、runbook link を含み、personal data を含めません。

## Sources

- `inception/requirements-analysis/requirements.md` NFR7
- `construction/u1-walking-skeleton/functional-design/functional-spec.md`
- `construction/u1-walking-skeleton/nfr-requirements/nfr-requirements-questions.md`

## Assumptions & Open Questions

- observability vendor は Infrastructure Design で決定します。
