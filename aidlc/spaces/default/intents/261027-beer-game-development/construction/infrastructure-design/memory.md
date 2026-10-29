<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
- 2026-10-29 [unit u3-learning-view] — U3 は既存 ECS application と PostgreSQL を共有し、SQS/S3 を projection/export の非同期境界として追加する。
- 2026-10-29: U2 は新しい deployable service を追加せず、U1 の ECS service と RDS authority を拡張する。
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->

## Tradeoffs
- 2026-10-29 [unit u3-learning-view] — 独立 service と Redis を避け、現負荷では modular monolith の運用単純性と cost を優先する。
- 2026-10-29: baseline 規模では broker を増やさず PostgreSQL outbox を採用し、運用費と障害点を抑える。
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->

## Open questions
- 2026-10-29: region、account、production instance class は environment provisioning 時に確定する。
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
