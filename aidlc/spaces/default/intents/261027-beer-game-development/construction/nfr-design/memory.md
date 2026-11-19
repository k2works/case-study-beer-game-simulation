<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
- 2026-11-05 [unit u4-retention-operations] — C5 に `attempt` を必須追加し、current attempt と一致する完了通知だけで Saga 状態を更新する設計とした。
- 2026-11-05 [unit u4-retention-operations] — 24 時間削除 SLO は rolling 30 日の期限到達 Saga 全件を母集団とし、目標 99% とした。
- 2026-10-29 [unit u3-learning-view] — U3 は modular monolith 内の CQRS read-model slice とし、session partition が ordering と failure isolation の単位となる。
- 2026-10-29: U2 は U1 の modular monolith と PostgreSQL authority を継続し、session continuity を独立 service ではなく明確な logical component boundary として設計した。
- 2026-10-29: recovery token の「keyed digest」は HMAC-SHA-256 + key version として具体化し、raw token をすべての persistence / telemetry から排除した。
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->

## Deviations
- 2026-10-29: upstream NFR review が指摘した NFR1〜NFR9 との追跡断絶は、U2 固有 traceability の対象を NFR10〜NFR14 に限定しつつ、共通品質は U1 設計と team rules の継承として各 design に明示した。
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->

## Tradeoffs
- 2026-11-05 [unit u4-retention-operations] — status query は鮮度と整合性を優先して cache を置かず、PostgreSQL の indexed projection を採用した。
- 2026-11-05 [unit u4-retention-operations] — C5 の required field 追加は互換性コストを伴うが、旧 attempt の遅延通知による状態破壊を防ぐため major contract change とした。
- 2026-10-29 [unit u3-learning-view] — cache を初期導入せず、index と async export で目標を満たしてから測定結果に基づき追加する。
- 2026-10-29: shared cache と新規 broker は導入せず、PostgreSQL outbox と snapshot reconciliation を選んだ。baseline 規模での運用複雑性を抑え、将来の broker 分離が可能な component boundary を残す。
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->

## Open questions
- 2026-10-29 [unit u3-learning-view] — replay/snapshot port は C3 owner と formal contract を補完する必要がある。
- 2026-10-29: concrete managed PostgreSQL topology、backup retention、autoscaling platform は Infrastructure Design で確定する。
- 2026-11-07T02:54:50Z [unit u5-accessible-experience] — 共有 browser 契約と CSRF 方針、accessibility の画面横断設計、性能測定の母集団と時刻境界にレビュー上の懸念が残った。Code Generation 前にこれらを確定する。
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
