<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->
- 2026-11-13T04:55:07Z [unit u5-results-retention] 結果画面の「需要」の系列は、各役割が受けた注文（ordersReceived。小売店では顧客需要）にした。FR13.1 は「需要と全役割の注文…」と書くが、需要は 1 本の系列で、4 役割を重ねる比較（Q1 の A）には各役割の受注の方が増幅の過程を示せるため。顧客需要そのものは customerDemand として結果と出力に含める。
- 2026-11-13T04:55:07Z [unit u5-results-retention] 自動終了の「最後の操作」は、GameRow に時刻の列がないため、games.last_operation_at を足して持つ設計にした。履歴や週の記録の時刻から導くと、参加と開始（履歴の 7 種類にない）や参加者の入力が漏れるため。状態を変える保存と同じ保存の中で更新する（BR25.2）。

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->
- 2026-11-13T04:55:07Z [unit u5-results-retention] 契約 C3 が U5 の表として挙げた retention_policies は作らない。保持期間はアプリケーションの設定だけで持つ（Q3 の A）ため。contract-summary.md の C3 の U5 の行を、last_operation_at の追加に直した。
- 2026-11-13T04:55:07Z [unit u5-results-retention] U3 の autoEnd(gameId) は期限の再検査を持たない。U5 の自動終了は、選んだあとに操作があったゲームを終了しないために、占有の中で期限を再検査する必要がある（BR25.4）。autoEnd に期限の時刻を受け取る引数を足す設計にした。

## Tradeoffs
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->
- 2026-11-13T04:55:07Z [unit u5-results-retention] CSV は、先頭が = + - @ の値も元のまま出す（Q6 の A）。表計算ソフトで開くと式として実行される恐れが残る代わりに、読み戻した値が元と一致することを優先した。出力は進行役だけが取得でき、表示名は参加者が自分で入力する値なので、リスクは進行役が開く場合に限られる。
- 2026-11-13T04:55:07Z [unit u5-results-retention] 削除したことの記録はログにだけ残し、DB に「削除済み」の表を持たない（Q8 の A）。削除済みかどうかを後から確かめられない代わりに、個人情報とゲームの痕跡を DB に残さない。

## Open questions
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
- 2026-11-13T04:55:07Z [unit u5-results-retention] 保持期間を短くする設定変更（Q4 の A）で、多くの終了済みゲームが一度に削除対象になる。1 回の上限（既定 100 件）で周期ごとに分けて削除するが、運営者への事前の注意を運用手順書に書くか。
- 2026-11-13T04:55:07Z [unit u5-results-retention] 複数台で動かすときのアドバイザリロックは、接続の扱い（プールから取った 1 本の接続で取って放す必要がある）に依存する。インフラの設計の工程で確かめる。
