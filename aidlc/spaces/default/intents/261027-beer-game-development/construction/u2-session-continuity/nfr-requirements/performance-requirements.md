# Performance Requirements - U2

## Targets

- **NFR10.1** pause / resume / proxy decision API は p95 500 ms 以下、p99 1 s 以下とします。
- **NFR10.2** reconnect snapshot は 75 concurrent users で p95 1 s 以下とします。
- **NFR10.3** SSE reconnect と snapshot reconciliation は network 復旧後 5 s 以内に最新 version を表示します。

## Verification

Vitest integration test と k6 smoke test で測定し、production-like PostgreSQL を使用します。

## Sources

`functional-design/functional-spec.md`、`requirements.md`、`contract-summary.md`。
