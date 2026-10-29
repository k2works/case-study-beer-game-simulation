# Unit Test Instructions - U2 Session Continuity

## Framework and command

- Framework: Vitest + Playwright。PostgreSQL integration tests は container-backed test database を使用します。
- U2 unit / integration exact command: `npm --prefix apps/beer-game exec vitest run tests/u2`
- U2 E2E exact command: `npm --prefix apps/beer-game exec playwright test tests/e2e/u2.spec.ts`
- U1 regression remains green through: `npm --prefix apps/beer-game run verify:u1`

## Scope

各 component に 5〜8 tests を用意し、合計 30〜40 tests を目安にします。最低限、lifecycle transition、proxy audit、credential rotation、invalid / deleted token、rate limit、stale version、duplicate idempotency、transaction rollback、outbox replay、restart restore、role-safe projection、SSE gap reconciliation を対象にします。

## Coverage

U2 source を含む project line coverage は 80% 以上を維持します。security と transaction branches は branch coverage も確認し、未達を threshold 低下で回避しません。

## Test data and isolation

- Given/When/Then fixture は game / session / role identifiers を test ごとに生成します。
- clock と random source は interface 経由で deterministic fake を注入し、production token generator 自体は entropy / length contract を別 test で検査します。
- PostgreSQL integration test は transaction または schema reset で隔離し、migration を clean database に適用します。
- external telemetry と delivery sink は spy adapter に置換し、database transaction と C2 owner interface は mock せず integration boundary を検証します。

## Failure cases

happy path に加えて、最低 2 error / edge cases を各主要 behavior に含めます。特に concurrent rotation、stale If-Match、paused draft preservation、database rollback、duplicate outbox event、credential redaction を必須とします。
