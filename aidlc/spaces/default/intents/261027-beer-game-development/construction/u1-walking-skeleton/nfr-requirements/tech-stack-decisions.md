# Tech Stack Decisions - u1-walking-skeleton

## Selected Stack

| Concern | Selection | Rationale |
|---|---|---|
| Language | TypeScript on Node.js 22.x | browser / API / contract type sharing、既存 ESM tooling との整合 |
| Frontend | React | role-safe interactive UI、form state、SSE reconciliation、Playwright accessibility test |
| Backend | Fastify | schema-first HTTP boundary、low overhead、explicit plugin / module separation |
| Database | PostgreSQL | atomic week transaction、optimistic concurrency、unique idempotency scope、outbox durability |
| Live update | Server-Sent Events + polling fallback | U1 は server-to-browser update が中心で、WebSocket より単純な reconnect model |
| Unit / integration test | Vitest | TypeScript と高速な BDD-style test、pure SimulationEngine golden test |
| Browser E2E | Playwright | 4 role + facilitator flow、cross-browser、keyboard、SSE / polling test |

## Alternatives and Trade-offs

- Next.js は full-stack integration が速い一方、modular-monolith の application boundary と transaction service を framework routing から分離する必要があるため採用しません。
- Spring Boot は transaction / security 機能が強い一方、既存 Node.js environment と frontend 型共有に別 toolchain が必要なため U1 では採用しません。
- WebSocket は双方向 extension に適しますが、U1 の command は HTTP、push は一方向で十分なため SSE を選びます。
- short polling only は単純ですが 2-second reflection target と connection efficiency の両立で不利なため fallback に限定します。

## Quality and Delivery Constraints

| ID | Requirement |
|---|---|
| NFR8.1 | Given/When/Then scenario と failing automated test を implementation 前に作成する。 |
| NFR8.2 | line coverage 80% 以上とし、SimulationEngine、authorization、idempotency、transaction rollback を branch / integration test で保護する。 |
| NFR8.3 | formatter、linter、type-check、unit、integration、E2E、coverage を clean checkout から再現可能に実行する。 |
| NFR9.1 | feature work は `develop` に統合し、release 時に `main` へ merge する。 |
| NFR9.2 | `main` merge は staging へ自動 deploy し、production は manual approval を要求する。 |

## Sources

- `codekb/case-study-beer-game-simulation/technology-stack.md`
- `inception/practices-discovery/team-practices.md`
- `inception/requirements-analysis/requirements.md` NFR6, NFR8, NFR9
- `construction/u1-walking-skeleton/nfr-requirements/nfr-requirements-questions.md`

## Assumptions & Open Questions

- package manager、ORM / query layer、migration tool、SSE broker topology は NFR Design / Code Generation plan で選定します。
