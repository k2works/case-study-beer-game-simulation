# Evidence（最終版）

## 調べたもの

- `aidlc/spaces/default/memory/team.md`, `project.md`（確定ベースライン、既存の Mandated/Forbidden/Corrections）
- CodeKB: `code-quality-assessment.md`, `technology-stack.md`（全文）。他の CodeKB は上記 2 件の記述に依拠し、深くは再読していない。
- `.github/workflows/` の一覧と、`beer-game2.yml` / `beer-game2-deploy-staging.yml` の主要行（Node は `.nvmrc`、PostgreSQL 18-alpine、staging の `push` トリガーがコメントアウト）。
- `git log --oneline -15`（日本語 Conventional Commits、scope は `beer-game2`）。
- テスト・ビルド・audit は実行していない。カバレッジの実測値は未確認。

## 面談の決定（practices-discovery-questions.md）

- Q1 範囲: v1 の要件（FR-01〜15、NFR-01〜10）だけ。v2 の追加分は含めない。
- Q2 土台: 土台なしで 1 から作る。beer-game2 の設計は参考にするだけ。
- Q3 薄い一通り: 現在の内容のまま。1 ゲーム、4 役割、1 週分を確定して状態を表示する。
- Q4 カバレッジ: 行 80% だけを基準とする。beer-game2 の 85/85/85/75 は引き継がない。
- Q5 CI/デプロイのワークフロー: beer-game3 用に別に新しく作る。
- Q6 自動反映: 方針は変えず、main への merge で staging へ自動反映を実際に動かす。production は手動承認後。AWS は beer-game3 専用に用意する。
- Q7 版: Node 26 / PostgreSQL 18。
- Q8 ブランチ/コミット: develop に統合し、リリース時に main へ merge。日本語の Conventional Commits、scope 名は `beer-game3`。

## ルール化の判断

既存の project.md ルールと矛盾する回答はなく、新規の ALWAYS/NEVER は追加しなかった。CI/Deploy の新設、AWS 専用化、版の固定、カバレッジ基準は team-practices.md の方針として記録し、厳守事項としては扱わない（確信がないため）。

## 未解決の不確実性

1. ASM-01（既定の顧客需要系列）: 未確定。
2. JSD preset: 未確定。JSD 準拠の受入判定は保留とする既存方針（project.md Corrections）が続く。
3. staging 自動反映は beer-game2 で AWS 上未検証だった。beer-game3 では実際に動かすと決めたが、実現は未確認。
4. カバレッジの実測値は未確認（beer-game3 にはまだコードがない）。
