# Scalability Requirements - u1-walking-skeleton

## Capacity Targets

| ID | Requirement | Evidence |
|---|---|---|
| NFR1.6 | initial capacity は 15 concurrent game、各 game 5 active user、合計 75 SSE connection とする。 | load test |
| NFR1.7 | burst として全 60 role が 10 seconds 内に decision submit しても error rate 1% 未満、duplicate side effect 0 件とする。 | burst test |
| NFR1.8 | 50 week × 15 game の active state と outbox event を performance target 内で処理する。 | maximum-session benchmark |
| NFR6.1 | stateless HTTP/SSE application instance を追加して capacity を水平拡張でき、authoritative state は PostgreSQL に置く。 | two-instance integration test |

## Scaling Triggers

- 5 分 window で API p95 が 800 ms を超える、database pool utilization が 70% を超える、または SSE delivery lag p95 が 1 second を超える場合に capacity alert を発火します。
- connection affinity を correctness の前提にせず、reconnect は last known version から state reconciliation を行います。
- U1 の scale target を超える拡張は、measured saturation point と database contention を基に判断します。

## Sources

- `inception/requirements-analysis/requirements.md` NFR1, NFR6
- `construction/u1-walking-skeleton/functional-design/functional-spec.md`
- `construction/u1-walking-skeleton/nfr-requirements/nfr-requirements-questions.md`

## Assumptions & Open Questions

- multi-region active-active は U1 の target load に対して対象外です。
