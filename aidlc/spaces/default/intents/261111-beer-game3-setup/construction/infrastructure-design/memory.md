<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->
- 2026-11-13T22:12:00Z — [u6-nfr-verification] U1〜U5 には beer-game3 の CI が存在せず（`.github/workflows/` に beer-game3 用がない）、Infrastructure Design は U6 で初めて該当した。U6 のインフラは CI の実行環境（GitHub Actions と使い捨ての PostgreSQL）だけで、デプロイは含めない（Q7 の A）。

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->
- 2026-11-13T22:12:00Z — [u6-nfr-verification] 質問票を作る前に 4 文書の下書きを書いてしまい、確認前の保存として記録された。回答（Q1 の A、Q2 の A）と確認の後に該当箇所を直して再保存した。順序は質問票、確認、生成が正しい。

## Tradeoffs
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->
- 2026-11-13T22:12:00Z — [u6-nfr-verification] 必須のチェックを集約のジョブ `gate` の 1 つに絞る。行列のジョブ名と飛ばされたジョブの名前に統合の保護を依存させない代わりに、`gate` の判定規則が複雑になる。

## Open questions
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
- 2026-11-13T22:12:00Z — [u6-nfr-verification] **要対応（Code Generation の計画で確定する）**: 第 2 回のレビュー（READY）の Major の新規指摘。`schedule` と `workflow_dispatch` では `relevant` が常に真になるが、`verify`、`e2e`、`a11y`、`load-smoke` は「`relevant` が真の PR と push」でしか動かず、`gate` の判定 (3) だと夜間と手動の `gate` が毎回失敗する。`gate` の判定を起動の種類ごとに書き分ける（`schedule` と `workflow_dispatch` は `load-main` を必須にしてほかを `skipped` で許す）か、`gate` を `pull_request` と `push` だけで動かすかを決める。READY の記録後のため、設計文書は直していない。
- 2026-11-13T22:12:00Z — [u6-nfr-verification] Minor: `pull_request` の `types` に `edited` がなく、`develop` 向けの PR を `main` 向けに付け替えると `load-main` なしで merge できる。`edited` を足すか、リリースの手順書の条件に書く。
- 2026-11-13T22:12:00Z — [u6-nfr-verification] Minor: `relevant` が `false` でも `true` でもない値のとき、`gate` は検証を要求する側（`true` 扱い）に倒す規則にする。
