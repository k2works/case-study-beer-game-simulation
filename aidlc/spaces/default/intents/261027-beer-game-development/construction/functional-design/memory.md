<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
- 2026-10-29: LearningView は write model を直接参照せず、C3 event と owner-provided rebuild interface から projection を構築する。
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->
- 2026-10-28 [unit u1-walking-skeleton] — week commit は 4 role の入力後に facilitator が明示実行し、自動確定しない。
- 2026-10-28 [unit u1-walking-skeleton] — facilitator credential と participant recovery token を分離し、game / role 単位で command authorization を行う。

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->

## Tradeoffs
- 2026-10-29: プレイ中の合計値は低母数または逆算可能時に抑止し、完全な観察性より情報制約を優先する。
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->
- 2026-10-28 [unit u1-walking-skeleton] — decision の同時編集は last-write-wins ではなく optimistic concurrency で stale update を拒否する。
- 2026-10-28 [unit u1-walking-skeleton] — idempotency result は actor + operation + resource scope で 24 hours 保持し、異なる payload の key 再利用を conflict とする。

## Open questions
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
- 2026-10-28 [unit u1-walking-skeleton] — quantity upper bound の安全な既定値、credential entropy、timeout budget は NFR stage で数値化する。
- 2026-10-28 [unit u1-walking-skeleton] — architecture review は role 共有、12-step calculation、create-game idempotency、role assignment / start contract、event ordering の 5 点を Major finding とした。
