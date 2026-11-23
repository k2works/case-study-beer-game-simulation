---
type: Plan
title: "Bolt 13 計画 - 投影の再構築・整合検査・スキーマ進化（Rust 版）"
description: "beer-game-rust の Bolt 13 のステップ計画。ProjectionLock（アドバイザリロック。コマンドは共有、再構築は排他）、rebuild-projections と verify-projections の起動モード、projection-rebuild.feature の許可、EventCodec のアップキャストと N-1 互換の確認。人の承認待ちの草案。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-23T00:00:00Z }
---

# Bolt 13 計画 - 投影の再構築・整合検査・スキーマ進化（Rust 版）

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B13（[リリース計画](./release_plan.md)）。Unit U5 |
| 所要（計画） | 2 稼働日（仮定。`ProjectionLock` の追加が全コマンドに及ぶため、超える可能性がある） |
| ゲート密度 | **密**（ステップごとに人が検証。ロックの導入は先にゲート） |
| 状態 | **人の承認待ちの草案** |

### ゴール

投影を `events` からいつでも作り直せる（1 ゲームを 1 トランザクション、排他のロック）。整合の検査（投影を変えず、作り直した結果と比べる）で不一致 0 件を確かめる。コマンドは共有のロック、再構築は排他のロックを取り、同時には走らない。イベントの形の変更を、`schema_version` とアップキャストで吸収できる土台を作り、N-1 互換を確かめる。

### 確認したい仮説（リリース計画より）

1. 再構築の結果が元の投影と一致するか（不一致 0 件）。
2. sqlx でアドバイザリロックを扱えるか。再構築中のコマンドは、`lock_timeout` の範囲で待つか、すぐ失敗するか。ロックと接続が解放されるまでの遅れで、プールが枯渇しないか（設計 architecture-backend.md の H2・H3）。
3. 旧版のイベント（`schema_version` が古い）を、アップキャストで読めるか。研修中の運用（停止 → 再構築 → 再開）は成立するか。

## 現状の確認（読み取りで確かめた事実）

- **`ProjectionLock` は未実装**。`pg_advisory_*` と `lock_timeout` は、テスト以外のコードに無い。設計は「コマンドは共有、再構築は排他」としているので、**B13 で全コマンドの `execute` にロックを足す**（B2 の RB2 の spawn・ROLLBACK の経路に触る。高リスク）。
- `EventCodec` の `decode` は `_schema_version` を使っていない（アップキャストは未実装）。
- `projection_checkpoints`（0001）はあり、投影の表は 0003〜0005、保持の表は 0009 まで。
- 共有する `features/operations/projection-rebuild.feature`（`@NF-R15`、5 シナリオ、`@api`）は、許可リストに無い。**ステップは Rust 側に未実装**（「投影をすべて空にする」「行を 1 つ書き換える」は、試験が保存先を直接書いて再現する）。
- `app` の起動モードは `api`・`migrate`・`retention`・`healthcheck`。`rebuild-projections`・`verify-projections` は未実装。

## 対象の受入条件

| 対象 | 内容 | feature |
| :--- | :--- | :--- |
| NF-R15 | 投影の再構築の一致、`projected_version` と `MAX(stream_version)` の一致 | `operations/projection-rebuild.feature`（5 シナリオ。許可リストへ） |
| NF-P18 | 1 ゲーム（SESSION 1000 件）の再構築 p95 1 秒以下。100 ゲームを 5 分以内 | 計測して記録（目標は設計の提案値。未計測なら「未計測」と書く） |
| RT2 | キャンセル安全性（ロック・接続の解放時間、プールの状態） | B13 で、ロックを足したうえで確かめる |

## 着手前に人の判断が要る項目

| # | 項目 | 案 |
| :--- | :--- | :--- |
| 1 | **ロックの導入と範囲** | `execute`（全コマンド）の先頭で `pg_advisory_xact_lock_shared(hashtext(game_id))` を取る。再構築は `pg_advisory_xact_lock`（排他）。**トランザクションの終了で解放**（`_xact_`）されるため、接続の切断でも残らない |
| 2 | **`lock_timeout` の値** | 初期値は 2 秒（**実測で決める**。設計 M4）。超過（SQLSTATE 55P03）は `RetryExhausted` に写し、503 を返す |
| 3 | **再構築中のコマンドの応答** | 短い待ち（`lock_timeout`）のあと 503（`Retry-After` つき）。Kotlin 版の決定に追従 |
| 4 | **DDL** | **不要の見込み**。既存の表だけで足りる。権限は `beergame_writer`（投影の DELETE を持つ）で実行。**新しいロールは作らない** |
| 5 | **新規依存** | なし（見込み。アドバイザリロックは SQL を直接発行） |
| 6 | **アップキャストの実体** | 現行の版（1）しか無いので、**仕組み（旧版の DTO → 新版の純粋関数の列）と、テスト用の旧版のイベントでの確認**まで。実際の版の引き上げは、必要になったときの別の判断 |
| 7 | **N-1 互換の CI ジョブ** | 前のリリースのイメージで書いたイベントを、今のコードで読める確認。**CI の必須ジョブの追加は、守りの導入計画（別計画・承認待ち）の範囲**なので、B13 では**手元で実行できる形**まで |
| 8 | **契約 `openapi.yaml`（共有物）の変更** | 不要の見込み（再構築・検査は HTTP に出さない起動モード） |

## ステップ計画（各ステップの終わりで人のゲート）

1. **読み取り**: `projection-rebuild.feature`、Kotlin の `JdbcProjectionMaintenance`・`ProjectionMaintainer`・`ProjectionMode` を読み、Rust との差を一覧にする。未実装の確認（上の「現状」）を記録する。
2. **ロックの設計の承認（人のゲート）**: 上の判断項目 1〜3 を確定する。
3. **Red（先に書く）**: ロックの振る舞いの Given/When/Then。
   - 再構築（排他）の間、コマンドは `lock_timeout` のあと 503 になる。
   - 再構築が終われば、コマンドは通る。
   - 接続が切れてもロックが残らない（RT2）。
   実 PostgreSQL で失敗を確かめる。
4. **`ProjectionLock` の実装**（`adapter-persistence`）と、`execute` への導入。既存の全テストが通ることを確認する（B2 の RB2・冪等・競合の再試行）。
5. **再構築と整合検査**: ポート `ProjectionMaintenance`（`games`・`rebuild`・`verify`）。`rebuild` は、投影の行をすべて消し、`events` から作り直して確定する。`verify` は、作り直した結果と比べたあとで取り消す（投影を変えない）。`projection_checkpoints` と `MAX(stream_version)` の比較。1 ゲームの失敗が他に波及しない。
6. **起動モード**: `rebuild-projections [ゲーム ID ...]`、`verify-projections`。終了コード（設計 architecture-infrastructure.md の表: 失敗 1、一覧を読めない 70、形が不正な ID 64）。
7. **許可リストと受入のステップ**: `projection-rebuild.feature` の 5 シナリオを許可し、ステップ（投影の控え・破壊・再構築・検査）を実装する。保持方針の行が無いゲームを再構築で補う（0009 以前に作られたゲーム）。
8. **アップキャスト**: `EventCodec` に、旧版の DTO → 新版への純粋関数の列を足す（現行版のみで、仕組みの確認。テスト用の旧版のイベントで読めること）。N-1 の確認を、手元で実行できる形で用意する。
9. **計測**: NF-P18（1 ゲーム SESSION 1000 件、100 ゲーム）、`lock_timeout` の値の実測。方法と回数を記録する。
10. **品質ゲート・記録**: `just backend-check`、`just acceptance`、`just ui-acceptance`（**Node 26 で実行**）。`bolt_13_report.md`、`index.md`、`mkdocs.yml`、`docs/log.md`、`apply-okf` と `okf:check`。
11. **コミット・push・CI**（区切りごと）。

## 範囲外

観測・アラーム（B14）、本番の定義・定期の起動・タスクの実行基盤（B15）、必須ジョブ・hook の導入（守りの導入計画）、版の実際の引き上げ。

## リスク

| # | リスク | 対応 |
| :--- | :--- | :--- |
| R1 | 全コマンドへのロックの追加で、既存の並行処理（RB2、冪等、自動確定の競合）が壊れる | Step 3 で先にテストを書き、既存の全テストと許可リスト（139 件＋）を毎回通す。ロックの導入は単独のコミットにする |
| R2 | ロック待ちで接続が積み上がり、プールが枯渇する | `lock_timeout` を必ず設定し、RT2 でプールの状態を確かめる |
| R3 | 再構築が元と食い違う投影の定義（例: 0009 以前のゲームの保持方針の行） | 検査で不一致を検出する。Step 7 のシナリオで補う動作を確かめる |
| R4 | 破壊の再現（直接 DB を書く）が、本番の権限の設計とぶつかる | 試験用の接続（所有者）で行い、本番のロールの権限は変えない |
| R5 | NF-P18 の目標が未計測で、達成を断言できない | 計測値をそのまま記録する。目標未達なら、人の判断項目として挙げる |

---

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-23 | 初版作成（草案。人の承認待ち） | claude-code |
