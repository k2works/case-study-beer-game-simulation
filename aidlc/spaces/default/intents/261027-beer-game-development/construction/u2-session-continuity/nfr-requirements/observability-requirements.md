# Observability Requirements - U2

## Signals

- **NFR14.1** lifecycle transition、proxy decision、recovery success/failure、stale conflict を structured log と metric に記録します。
- **NFR14.2** log は correlationId、gameId、actor type、action、result、latency を持ち、raw credential を含めません。
- **NFR14.3** recovery failure spike、outbox lag 30 s 超過、restart recovery failure を 1 minute 以内に alert します。
- **NFR14.4** audit event sequence gap と duplicate を invariant check で検出します。

## Verification

Redaction test、metric assertion、synthetic alert test を CI / staging で実施します。

## Sources

`functional-design/functional-spec.md`、U1 observability design。
