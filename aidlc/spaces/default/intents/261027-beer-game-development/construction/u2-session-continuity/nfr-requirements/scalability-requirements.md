# Scalability Requirements - U2

## Targets

- **NFR12.1** 25 concurrent games / 100 SSE connections を 2 application instances 以上で処理します。
- **NFR12.2** reconnect は sticky session に依存せず、どの instance でも PostgreSQL authority から復元します。
- **NFR12.3** event delivery は durable outbox と consumer idempotency により instance 間で順序を維持します。

## Verification

Multi-instance integration test で reconnect、event gap、duplicate delivery を検証します。

## Sources

`functional-design/functional-spec.md`、U1 infrastructure specification。
