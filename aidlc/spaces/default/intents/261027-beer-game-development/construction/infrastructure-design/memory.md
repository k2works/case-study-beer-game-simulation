<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
- 2026-11-05 [unit u4-retention-operations] — 削除 worker を独立 ECS Fargate service とし、owner queue 単位で scale する。
- 2026-11-05 [unit u4-retention-operations] — PITR 復旧後は receipt 読取を閉じ、期限切れ sweep を完了してから再開する。
- 2026-10-29 [unit u3-learning-view] — U3 は既存 ECS application と PostgreSQL を共有し、SQS/S3 を projection/export の非同期境界として追加する。
- 2026-10-29: U2 は新しい deployable service を追加せず、U1 の ECS service と RDS authority を拡張する。
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->

## Tradeoffs
- 2026-11-05 [unit u4-retention-operations] — C5 v1 を状態遷移へ推測で適用せず隔離し、v2 producer の切替まで対象の削除開始を止める。移行期間中の遅延より誤完了防止を優先した。
- 2026-10-29 [unit u3-learning-view] — 独立 service と Redis を避け、現負荷では modular monolith の運用単純性と cost を優先する。
- 2026-10-29: baseline 規模では broker を増やさず PostgreSQL outbox を採用し、運用費と障害点を抑える。
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->

## Open questions
- 2026-11-05 [unit u4-retention-operations] — C5 v2 の共有契約 schema と retry 回数の上流不一致は Code Generation 前に解消する。
- 2026-10-29: region、account、production instance class は environment provisioning 時に確定する。
- 2026-11-07T03:00:02Z [unit u5-accessible-experience] — edge の header / cookie / query 転送、反映時間の clock 境界、共有 browser 契約、75 接続からの拡張条件にレビュー上の懸念が残った。実装計画前に設定と試験条件を確定する。
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
