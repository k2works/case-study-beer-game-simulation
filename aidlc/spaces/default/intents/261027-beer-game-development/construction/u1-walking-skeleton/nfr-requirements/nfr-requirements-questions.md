# NFR Requirements Questions - u1-walking-skeleton

## Q1 Availability target

授業・workshop 中の application availability target をどうしますか？

- A. 99.5% monthly with session-window alerting
- B. 99.9% monthly
- C. Best effort without SLO
- X. Other (please specify)

[Answer]: A. 99.5% monthly with session-window alerting

## Q2 Recovery target

確定済み week の durability と障害復旧目標をどうしますか？

- A. RPO 0 for committed weeks, RTO 15 minutes
- B. RPO 5 minutes, RTO 1 hour
- C. RPO 24 hours, RTO 4 hours
- X. Other (please specify)

[Answer]: A. RPO 0 for committed weeks, RTO 15 minutes

## Q3 Credential lifetime

facilitator credential と participant recovery token の期限をどうしますか？

- A. Game end + 24 hours; revoke immediately on deletion
- B. Retention period end; revoke on deletion
- C. No expiry before explicit revocation
- X. Other (please specify)

[Answer]: A. Game end + 24 hours; revoke immediately on deletion

## Q4 Application stack

U1 の application stack をどれにしますか？

- A. TypeScript + React + Fastify + PostgreSQL + Vitest/Playwright
- B. TypeScript + Next.js + PostgreSQL + Vitest/Playwright
- C. Java + Spring Boot + React + PostgreSQL
- X. Other (please specify)

[Answer]: A. TypeScript + React + Fastify + PostgreSQL + Vitest/Playwright

## Q5 Live state delivery

week commit 後 2 秒以内の browser state update をどの transport で実現しますか？

- A. Server-Sent Events with reconnect and polling fallback
- B. WebSocket
- C. Short polling only
- X. Other (please specify)

[Answer]: A. Server-Sent Events with reconnect and polling fallback

## Sources

- `construction/u1-walking-skeleton/functional-design/functional-spec.md`
- `construction/u1-walking-skeleton/functional-design/rules.md`
- `construction/u1-walking-skeleton/functional-design/reviews/review-01.md`
- `inception/requirements-analysis/requirements.md`
- `inception/contract-design/contract-summary.md`
- `codekb/case-study-beer-game-simulation/technology-stack.md`

## Assumptions & Open Questions

- NFR1 の p95 1 second と state reflection 2 seconds、15 team × 5 active user は既決定です。
- None.
