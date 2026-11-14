# Code Quality Assessment

実行はしていません（テスト・ビルド・audit とも）。設定とファイルから確認できる範囲です。

## テスト

- beer-game2: unit 14、component 2、integration 9、e2e 4 のファイル。Vitest + Testing Library + `fast-check`（プロパティ）+ Playwright + axe。受入条件との対応表を `npm run acceptance` で検査（未対応で失敗）。
- カバレッジ設定あり: v8、対象は domain / application / http / persistence、しきい値 lines・functions・statements 85、branches 75（チームの 80% line を上回る）。実測値は未確認。
- 統合テストは同じテスト DB を使うため直列実行。
- beer-game（v1）: `tests/u1..u5` と e2e。カバレッジは u1〜u5 に限定。

## 品質ゲート

- beer-game2: Prettier、ESLint（`--max-warnings=0`、層の依存の検査）、`tsc --noEmit`、カバレッジ、受入対応表、ガイドツアー検査、E2E を `npm run verify` と CI で実行。Terraform の `fmt` / `validate`、`shellcheck`、コンテナ検査、`npm audit` も CI にある。
- 評価（3 段階）: 命名と層の分離は良、テストの存在は良、エラーの扱いは未精査、重複は未精査、デッドコードは未精査。

## CI/CD

`beer-game2.yml`（5 ジョブ）、`beer-game2-deploy-{staging,production}.yml`、`beer-game2-rollback-{staging,production}.yml`（OIDC、手動）、`beer-game-u1.yml`、`docker-publish.yml`、`mkdocs.yml`。staging の `push` トリガーはコメントアウトで、AWS では未検証と明記されている。

## ドキュメント

`apps/beer-game2/README.md` は充実。ルート `README.md` は概要・目的が空欄。`docs/` は OKF 形式で、beer-game2 は ADR 13 本、Bolt 1〜12 の計画と報告、リリース報告書 0.2.0 を持つ。v1 の `docs/development`、`docs/operation`、`docs/review` は `index.md` のみ。

## 技術的負債の兆候

- 大きなファイル: `application/index.ts` 913 行、`pg-repositories.ts` 684 行、`http/server.ts` 615 行、テストの `use-cases.test.ts` 1,611 行・`app.test.tsx` 1,529 行・`http.test.ts` 1,062 行。
- ルートの未整備: `package.json` の `name` が空で `{project_name}` が残る。`mkdocs.yml` の `site_name` が `Site Name`、`repo_name` が booster 由来。
- Node / PostgreSQL の版の不揃い（26 と 22、18 と 16）。
- v1 と v2 の重複（ワークフロー、Dockerfile、マイグレーション）。ワークフローはアプリ名固定。
- TODO / FIXME / HACK / `eslint-disable` / `@ts-ignore` は beer-game2 の `src`・`ui` と beer-game の `src` で 0 件。

## 未確定事項（確定事実ではない）

1. beer-game3 の範囲（v1 の要件のみか、v2 の追加分を含むか）。
2. 土台にするコード（v1、v2、新規）。
3. ASM-01（既定の顧客需要系列）。JSD 準拠の受入判定は保留とする既存方針がある。
4. Node と PostgreSQL の版。
5. staging 自動反映の規約は beer-game2 でも未達で、beer-game3 に引き継ぐかは未決定。
