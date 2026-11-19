<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->
- 2026-11-13T13:10:00Z — [u6-nfr-verification] NFR3.3 の「10 分間の本試験の中の別の区間」を、通常負荷の 10 分の後に続く 3 分の最大想定の区間として設計した（NFR4.1 の 10 週を保つため）。要件の字句どおりの「10 分の中」ではなく「本試験の実行の中」と読んだ。

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->
- 2026-11-13T13:10:00Z — [u6-nfr-verification] functional-spec.md が U6 にない（U6 は新しい業務機能を足さない）ため、NFR 要件と契約の要約だけを入力にして設計した。

## Tradeoffs
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->
- 2026-11-13T13:10:00Z — [u6-nfr-verification] 実ブラウザの測定は、別プロセスの試験の実行器でなく、負荷試験と同じプロセスの Playwright ライブラリで動かす。単調時計の統一と資格情報の持ち出し防止を得る代わりに、負荷試験のスクリプトが Playwright に依存する。
- 2026-11-13T13:10:00Z — [u6-nfr-verification] 最初のリリースの前の本試験の証拠は、main 向けのプルリクエストの起動で得る（schedule と手動実行は main に定義があるときだけ動くため）。手元の実行は合否の証拠にしない。

## Open questions
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
- 2026-11-13T13:10:00Z — [u6-nfr-verification] 実ブラウザの測定で、ブラウザが確定の応答の受信より先に新しい週を拾った場合の標本（0 未満）の扱いが未定（レビューの Minor）。Code Generation で 0 に丸めて件数を記録するか決める。
- 2026-11-13T13:10:00Z — [u6-nfr-verification] Edge の安定版を ubuntu の実行機で動かせること（Playwright の msedge チャンネルの導入）は、Code Generation で公式情報により確かめる。
