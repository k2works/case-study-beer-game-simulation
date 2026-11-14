<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->
- 2026-11-13T05:12:00Z [unit u5-results-retention] NFR11（画面と出力の言語は日本語のみ）の「出力」を、画面の文言とエラーの理由・直し方と読んだ。CSV と JSON の列名と役割の値（factory など）は、読み戻すための識別子として英語のままにする。出力のヘッダを日本語にする意図なら、規則 BR23.2 と出力の設計を変える必要がある。
- 2026-11-13T08:53:23Z [unit u6-nfr-verification] U6 は Functional Design を省いた（新しい業務機能・データモデル・業務ルールを足さないため）。NFR Requirements の入力のうち functional-spec.md と rules.md は存在しないので、requirements.md と unit-of-work.md、U1 の NFR を土台に要件を立てた。NFR の詳細番号は Unit ごとに 1 から振り直す（U1〜U5 の慣例に合わせた）。
- 2026-11-13T08:53:23Z [unit u6-nfr-verification] 5 つ目の NFR 区分に当たる「画面の品質」（NFR8、NFR10、NFR11）は、U5 と同じく performance-requirements.md に置いた。

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->
- 2026-11-13T05:12:00Z [unit u5-results-retention] Functional Design のレビューで挙がった所見のうち、要件として表せるもの（NFR2.3 結果の読み取りの一貫性、NFR2.4 失敗が続くゲームによる先頭詰まりの防止、NFR2.5 lastOperationAt の移行の補完、NFR4.2 ロックの接続の扱い）を、NFR の要件として取り込んだ。Functional Design の成果物（レビュー済み）は直していないため、entities.md の移行の補完と BR26.3 の記述は NFR の要件に読み替える。コード生成の工程で設計文書に反映する。
- 2026-11-13T08:53:23Z [unit u6-nfr-verification] 条件を満たさない Functional Design をこの Unit では省いた（report --result skipped）。他の Unit は実施済みなので、Stage の完了は Unit ごとの扱いになる。
- 2026-11-13T09:08:00Z [unit u6-nfr-verification] 夜間の本試験の検査対象を、Q3 の A の「main への統合後」から「develop を明示して取得」に直した。team の方針は develop 統合、リリース時だけ main へ merge で、定期実行は既定の branch（main）の内容で動くため、元の書き方では develop の劣化を捉えられない。Q3 の回答の意図（早期の検知）は変えていない。承認のときに人へ知らせる。
- 2026-11-13T09:08:00Z [unit u6-nfr-verification] レビューの Major「U6 固有の要件に上流と衝突しない ID（V6.x）を付ける」は取り込まなかった。NFR Requirements の手順が、詳細な要件に上流の NFR の番号を引き継ぎ小番号を足すと定め、traceability の検査もその形を前提とし、U1〜U5 も Unit ごとに 1 から振る慣例のため。代わりに、各文書に番号の付け方と上流の NFR との対応（U6 が検証する部分・しない部分と担当 Unit）を足し、traceability.json の各行に範囲を書いた。

## Tradeoffs
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->
- 2026-11-13T08:53:23Z [unit u6-nfr-verification] 負荷試験は専用の道具（k6）でなく Node.js のスクリプトにした（Q2 の A）。依存が増えず CI でそのまま動く代わりに、負荷の形の記述や集計の機能は自作になる。
- 2026-11-13T08:53:23Z [unit u6-nfr-verification] 1 つ前の世代のブラウザと実機の Safari は自動でなく確認票にした（Q4 の A）。依存の版が 2 本になる保守を避ける代わりに、手作業の記録が必要になる。
- 2026-11-13T08:53:23Z [unit u6-nfr-verification] CI の実行環境では負荷を生成する側とアプリケーションが同居するため、測定は保守的になる（NFR4.4）。合格の判断には安全側だが、閾値超過の原因の切り分けに実行環境の記録が要る。

## Open questions
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
- 2026-11-13T08:53:23Z [unit u6-nfr-verification] Playwright と axe-core は U1 の技術スタックの候補で、apps/beer-game3/package.json にまだ入っていない。版は公式情報で確かめて決める（Code Generation）。
- 2026-11-13T08:53:23Z [unit u6-nfr-verification] 既存の beer-game-u1.yml は apps/beer-game を指す古い CI で、beer-game3 の CI ではない。U6 の beer-game3.yml を作るときに、重複や競合がないか確かめる。
