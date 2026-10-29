<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->
- 2026-10-28 [unit u1-walking-skeleton] — availability は monthly 99.5%、active session outage は 1 minute 以内の alert とする。
- 2026-10-28 [unit u1-walking-skeleton] — committed week は RPO 0、incident recovery は RTO 15 minutes とする。
- 2026-10-28 [unit u1-walking-skeleton] — TypeScript、React、Fastify、PostgreSQL、Vitest、Playwright を application stack とする。
- 2026-10-29 [unit u3-learning-view] — query latency と event-to-visibility lag を別々の SLI とし、privacy 判定は fail-closed とする。

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->

## Tradeoffs
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->
- 2026-10-28 [unit u1-walking-skeleton] — live state は一方向 push に適した SSE を使い、connection failure 時は polling fallback で可用性を保つ。
- 2026-10-28 [unit u1-walking-skeleton] — credential は game 終了 24 hours 後に失効し、長期再接続より exposure window 短縮を優先する。
- 2026-10-29 [unit u3-learning-view] — 15 team 規模では cache を追加せず PostgreSQL projection を正本とし、実測後に再検討する。

## Open questions
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
- 2026-10-28 [unit u1-walking-skeleton] — architecture review は multi-instance SSE、RPO 0 guarantee、browser credential boundary、accessibility / browser compatibility、NFR4 traceability に Major finding を残した。
- 2026-10-29 [unit u3-learning-view] — C3 discriminated payload schema と snapshot/replay API は implementation 前に contract 補完が必要である。
