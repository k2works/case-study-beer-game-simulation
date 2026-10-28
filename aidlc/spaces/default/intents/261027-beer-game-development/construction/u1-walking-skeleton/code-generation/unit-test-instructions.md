# Unit Test Instructions - u1-walking-skeleton

## Setup

- Node.js 22.x、npm、Docker / Docker Compose を使用します。
- Step 1 で `apps/beer-game/package.json`、Vitest、Playwright、coverage provider、PostgreSQL test setup を作成します。
- test data は deterministic factory と transaction rollback で分離し、raw credential を fixture snapshot に保存しません。

## Exact Unit Command

```bash
npm --prefix apps/beer-game run test:u1
```

この script は U1 の unit / integration / contract tests だけを対象にし、最初の BDD scenario 作成前に runner が実行可能であることを確認します。

## Verification Command

```bash
npm --prefix apps/beer-game run verify:u1
```

`verify:u1` は formatter check、lint、type-check、U1 unit / integration、Playwright walking-skeleton E2E、accessibility / security smoke、80% line coverage を実行します。

## Test Scope

- SimulationEngine、authorization / serializer、idempotency、application command、repository、API、React interaction を各 5〜8 tests で保護します。
- Key integration boundaries は PostgreSQL transaction/outbox、OpenAPI、SSE reconciliation、HttpOnly cookie / CSRF です。
- E2E は 1 game、4 role、shared-role conflict、1 week commit、duplicate commit、role-private data non-disclosure を含みます。
- performance smoke は 75 user の本 load test を置換せず、latency regression の早期検出に限定します。

## Mocking and Stubbing

- SimulationEngine と repository integration は mock せず real implementation / PostgreSQL を使います。
- trusted clock、token generator、notification transport は deterministic adapter へ差し替えます。
- AWS service は local boundary fake と contract test を使い、cloud verification は pipeline / environment test で行います。

## Coverage

- line coverage 80% 以上を必須とし、business rule、authorization、idempotency、transaction rollback は branch coverage も監視します。
- target を下げたり exclude を追加して failure を回避しません。

## Sources

`code-generation-plan.md` と Testing Contract、U1 design artifacts。
