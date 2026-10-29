# Unit Test Instructions - U3 Learning View

## Command

`npm --prefix apps/beer-game test -- --run tests/u3`

## Scope

- Vitest: projection idempotency/order/gap/rebuild、inverse disclosure、ended review、authorization、CSV/JSON parity、partial failure。
- PostgreSQL/HTTP integration: atomic cursor updates and C3/C6 fixtures。
- 5〜8 tests per component、U3 line coverage 80% 以上、既存 suite green。

Use deterministic event fixtures and temporary database transactions. Stub actor/status ports only in unit tests; integration tests exercise real adapters. Never log tokens or protected payloads in failure snapshots.
