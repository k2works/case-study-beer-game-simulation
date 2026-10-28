# Performance Requirements - u1-walking-skeleton

## Targets

| ID | Requirement | Measurement |
|---|---|---|
| NFR1.1 | 15 team × 4 participant + 1 facilitator の同時利用時、decision submit と role-safe state query の server p95 を 1 second 以下とする。 | production-like data、最低 75 concurrent user、15 分 steady load |
| NFR1.2 | week commit 受理から全 connected browser の最新 state 表示までを p95 2 seconds 以下とする。 | transaction commit、SSE publish、browser render を end-to-end 計測 |
| NFR1.3 | week commit の server processing p95 を 1 second 以下、p99 を 2 seconds 以下とする。 | 4 role、50 week 相当の最大 pipeline state で計測 |
| NFR1.4 | SSE unavailable 時の polling fallback は 2 seconds 間隔を上限とし、最新 version 到達を commit 後 4 seconds 以内とする。 | connection failure を注入した E2E test |
| NFR1.5 | p95 target は warm-up 後の successful request を対象とし、validation / authorization error を別 series で計測する。 | latency histogram を operation / outcome 別に記録 |

## Resource Constraints

- quantity、week、pipeline length に明示的な上限を持ち、1 request の work を bounded にします。
- response は role-safe current state と必要な履歴 window に限定し、全 game history を毎回送信しません。
- load test は p50 / p95 / p99、error rate、database transaction time、SSE delivery lag を記録します。

## Sources

- `inception/requirements-analysis/requirements.md` NFR1
- `construction/u1-walking-skeleton/functional-design/functional-spec.md`
- `construction/u1-walking-skeleton/nfr-requirements/nfr-requirements-questions.md`

## Assumptions & Open Questions

- infrastructure sizing は NFR Design / Infrastructure Design で確定します。
