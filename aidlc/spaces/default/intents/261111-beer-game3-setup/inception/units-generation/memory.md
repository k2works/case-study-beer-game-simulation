<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->
- 2026-11-12T01:32:04Z — 画面は同じアプリケーションに含めるため、`ui` の Unit は分けず、すべて `service` とした。Q2 の A（1 つのデプロイ単位）と、縦割り（Q1 の A）に合わせた判断。

## Tradeoffs
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->
- 2026-11-12T01:32:04Z — 非機能の検証を独立した U6 にした。US5.3・US5.5・US5.7 は「任意の画面」を対象にし、全画面が揃ってから確かめる必要があるため、U6 は U1〜U5 すべてに依存させた。各 Unit も自分の画面について同じ検査を通す。

## Open questions
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
