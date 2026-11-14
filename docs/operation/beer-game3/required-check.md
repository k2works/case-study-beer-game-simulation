---
type: Reference
title: "必須のチェックの設定 - beer-game3"
description: "develop と main の保護で、必須のチェックを gate の 1 つだけにする設定の手順と戻し方。リポジトリの設定の変更は外部への反映になるため、承認を得てから行う。"
tags: [operation, ci, branch-protection]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T00:00:00Z }
---

# 必須のチェックの設定

> **状態: 未設定。** この設定は、リポジトリの設定の変更（外部への反映）です。Code Generation の完了後に、**あなたの承認を得てから**行います。ワークフローを作っただけでは、統合の保護は働きません。

beer-game3 の CI（`.github/workflows/beer-game3.yml`）が作る必須のチェックは、集約のジョブ **`gate` の 1 つだけ**です。`verify`、`e2e`（4 ブラウザの行列）、`a11y`、`load-smoke`、`load-main` の結果は、`gate` が判定します。行列のジョブ名や、飛ばされたジョブの名前に、統合の保護を依存させません。

| 理由 | 内容 |
| :--- | :--- |
| 行列のジョブは、飛ばされると展開前の名前 1 件だけが出る | ブラウザごとの名前を必須にすると、beer-game3 以外の変更の PR が待機のまま止まる |
| `changes` が失敗すると、依存するジョブがすべて飛ばされる | `gate` が `changes` の結果を見て、飛ばされた検証を成功と見なさない |

## 設定する内容

| 対象の branch | 設定 |
| :--- | :--- |
| `develop` | 必須のチェックを `gate` の 1 つだけにする。プルリクエストを必須にする |
| `main` | 同じ。リリース用のプルリクエスト（`develop` から `main`）では、`gate` が `load-main`（10 分間の本試験）の成功も要求する |

## 設定の手順

前提: ワークフローが `develop` に入り、プルリクエストで `gate` が少なくとも 1 回動いて、チェックの名前（`gate`）が確定している。

1. 現在の保護の設定を記録する（戻し方に使う）。

   ```bash
   gh api repos/{owner}/{repo}/branches/develop/protection > develop-protection-before.json
   gh api repos/{owner}/{repo}/branches/main/protection > main-protection-before.json
   ```

   保護がまだない branch は、`404` が返る。その場合は「保護なし」と記録する。
2. `develop` と `main` の保護の「必須のステータスチェック」に、`gate` を 1 つだけ加える（GitHub の画面の Settings の Branches、または `gh api` の `required_status_checks`）。ほかのジョブ名を加えない。
3. 設定した内容（日、人、変更前の保存先）を、この文書の「記録」に書く。
4. beer-game3 に関係のない変更のプルリクエストで、`gate` が成功して統合できること、beer-game3 の変更のプルリクエストで、検証のジョブが動いて `gate` が待つことを確かめる。

## 戻し方

設定を外すときは、次の順に行う。

1. 「設定の手順」の 1 で保存した変更前の内容を見る。
2. `develop` と `main` の保護から、必須のステータスチェックの `gate` を外す（変更前に保護がなかった branch は、保護を外す）。

   ```bash
   gh api -X DELETE repos/{owner}/{repo}/branches/develop/protection/required_status_checks
   gh api -X DELETE repos/{owner}/{repo}/branches/main/protection/required_status_checks
   ```

3. 外した日と理由を「記録」に書く。ワークフローの定義の変更を戻すときは、コミットを `git revert` する（ワークフローは定義だけで、外部の状態を持たない）。

CI が長期間使えない（GitHub の障害など）ときは、手元で `npm run verify` を実行して確認する。ただし、統合の保護は代替できないため、復旧するまで統合を待つ。

## 記録

| 日 | 人 | 内容 |
| :--- | :--- | :--- |
| — | — | 未設定 |

## 関連

- リリース前の確認票とリリースの条件: [リリース前の確認票](./release-checklist.md)
