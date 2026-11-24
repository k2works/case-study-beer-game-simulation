---
type: Plan
title: "守りの導入計画（Rust 版。hook・必須ジョブ・承認記録）"
description: "beer-game-rust の開発戦略（DS-15・17・18・21・22、git の hook、Claude Code の hook、CI の必須ジョブ、機械が読める承認記録）の導入計画。2026-11-22 にユーザーが承認。導入は、ステップごとに人が確認する。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-22T00:00:00Z }
---

# 守りの導入計画

> **2026-11-22 にユーザーが「承認」（範囲を確認: この計画を計画どおり導入する。導入は下の順序のステップごとに、人が確認する）。** 必須ジョブ（GitHub のブランチ保護）は、人が設定する。

## 背景

[開発戦略](./development_strategy.md) は、適用漏れを防ぐ守り（DS-1〜22）を定めている。**実装済み**は DS-1〜6・10・11・13・14（テストと CI の `check` ジョブ）。**未導入**は、次の 5 件と、git・Claude Code の hook、CI の必須ジョブの設定（B2〜B9 の承認の記録で、「着手前に計画を示して確認する」とした）。

## 提案

| # | 守り | 内容 | 影響 | 案 |
| :--- | :--- | :--- | :--- | :--- |
| DS-15 | 緩和（`allow`・`expect`）の承認の検査 | 理由つきの `#[allow(...)]` だけを許し、承認の一覧と照合する（`crates/guards`） | 低（既存の `allow` は理由つき。一覧を作る） | 導入する |
| DS-17 | `unsafe` の検査 | `unsafe` が無いこと（workspace の lint で `forbid` 済み）を、検査のテストでも確認 | 低 | 導入する |
| DS-18 | 依存の追加の承認 | `Cargo.toml` の依存の増減を、承認の記録と照合 | 中（B6・B7 で承認した依存の記録が要る） | 承認の記録（下）を作ってから導入 |
| DS-21 | 承認の記録（機械が読める） | `docs/development/beer-game-rust/approvals.yaml`（日付・承認者・範囲・根拠のメッセージの要旨）。AI が書くが、**根拠の出典を必須**にする | 中（記録の内容は人が検証する） | 導入する |
| DS-22 | 設計書の `verified` の検査 | `verified` が人の名前以外（AI）で付いていないこと | 低（`okf:check` と重複する部分は再利用） | 導入する |
| git hook | pre-commit に `cargo fmt --check`、pre-push に `clippy`・`cargo test --workspace`（Docker 要） | 開発者の手元で、緑でない push を止める（過去に、緑でないコミットを push した失敗が複数回あった） | 中（pre-push が数分かかる） | pre-commit だけ導入。pre-push は `just backend-check` の案内にとどめる |
| Claude Code の hook | コミット前に `just backend-lint` を走らせる | AI が緑でないコミットをするのを止める | 中 | 導入する（設定は人が承認） |
| CI の必須ジョブ | GitHub のブランチ保護で、`beer-game-rust / check`・`container`・`infra` を必須にする | マージの前に緑を要求 | **高**（リポジトリの設定の変更。外部の設定） | **人が GitHub の設定で行う**（AI は設定しない） |

## 順序（承認後。各ステップで人のゲート）

1. DS-21 の承認の記録（`approvals.yaml`）を、これまでの承認（2026-11-19〜22）から起こし、人が検証する。
2. DS-15・17・22 の検査を `crates/guards` に追加する（失敗するテストを先に）。
3. DS-18 を、承認の記録と照合する形で追加する。
4. git の pre-commit hook（`.githooks/` と `core.hooksPath` の案内。**リポジトリ全体に効くので、他のプロジェクトへの影響を確認**）。
5. Claude Code の hook（`.claude/settings.json`。人が内容を承認）。
6. 必須ジョブは、人が GitHub で設定する手順書だけを書く。

## 範囲外・リスク

- hook は、リポジトリの他のプロジェクト（beer-game3 など）の開発にも影響しうる。**`apps/beer-game-rust/` の配下の変更だけに反応する**ようにする。
- 承認の記録を AI が書くと、「AI が先回りして承認済みと書く」失敗（過去にあった）を再現しうる。**根拠の出典（会話の日付と発言）を必須にし、人が検証する。**

---

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-22 | 初版作成（草案。人の承認待ち。導入していない） | claude-code |
| 2026-11-22 | ユーザーの「承認」を記録（導入は、ステップごとに確認） | claude-code |
