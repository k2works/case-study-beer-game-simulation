---
type: Plan
title: "Bolt 8 計画 - カスタム条件（Rust 版）"
description: "beer-game-rust の Bolt 8 のステップ計画。初期在庫・遅延・費用単価・公開範囲のカスタム条件、設定の種別と変更した項目、可変の遅延の simulate_week、性質テスト。人の承認待ちの草案。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-22T00:00:00Z }
---

# Bolt 8 計画 - カスタム条件（Rust 版）

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B8（[リリース計画](./release_plan.md)）。Unit U3 |
| 所要（計画） | 2 稼働日（仮定。B7 までの実績では、人の検証時間を除いて 1 セッションに複数の Bolt が収まっている） |
| ゲート密度 | **密**（ステップごとに人が検証） |
| アプローチ | 中盤の**インサイドアウト**（ドメインの `simulate_week` から外へ） |
| 状態 | **草案。人の承認待ち。着手しない** |

### ゴール

ゲームの作成で、初期在庫・遅延（注文・配送・生産）・費用単価・公開範囲を変えられるようにする（`kind: CUSTOM`、`conditions`）。設定の種別（`settingsKind`）と変更した項目（`changedSettings`）を記録し、状況・ゲームの状態に返す。**遅延が可変でも `simulate_week` の性質が保たれる**ことを性質テスト（遅延 0 を含む）で確かめる。

### 確認したい仮説

1. 遅延を可変にしても、在庫の保存則・決定論・非負が保たれるか（遅延の範囲は契約で 1〜8 週。**遅延 0 を含む性質テストは、契約の範囲外の値も純粋関数として扱えるかの確認**）。
2. キット準拠の既存のゴールデンテスト（B1）が、遅延をパラメータ化しても変わらないか。
3. 設定の種別の判定（変更が無ければ `KIT`）を、純粋関数で書けるか。

### 対象の受入条件（共有する `features/game-setup/`）

| ストーリー | 受入条件 | 共有する feature |
| :--- | :--- | :--- |
| US1.1 | AC1.1.3（種別と変更した項目、キット準拠に条件を付けると拒否、初期在庫の反映）、AC1.1.4（範囲外の検証、複数の誤りを集める）、AC1.1.5（最終週の範囲） | `custom-conditions.feature`（9 シナリオ） |

`@ui` の `custom-conditions-ui.feature` は、`web/` が Rust のバックエンドで動くかの確認として、通る数を記録する。

## 着手前に人の判断が要る項目

| # | 項目 | 案 |
| :--- | :--- | :--- |
| 1 | **新規依存** | なし（見込み） |
| 2 | **DB スキーマ** | 変更なしの見込み。`game_overview.settings_kind`・`settings_changes`（jsonb）と `game_settings` は 0003 に既にある。**イベント `GameCreated` の `settings` の JSON に、条件を足す**（既存のイベントは、条件が無ければキットの値として読めるよう後方互換にする）。DDL が要ると分かれば、着手前に示して確認 |
| 3 | **契約 `openapi.yaml`（共有物）の変更** | 不要の見込み（`CustomConditions`・`commitMode` は定義済み）。差が出たら Kotlin 版に影響するため、変更前に確認 |
| 4 | **範囲の扱い**: 契約の範囲（遅延 1〜8 など）は domain が検証する。性質テストの「遅延 0」は、`simulate_week` が任意の遅延で壊れないことの確認であり、API では受け付けない | 案どおり |
| 5 | **`commitMode`（自動確定の指定）** は B9 | B8 では、指定を受け取って保存するところまで（動作は B9）。範囲外にするかは Step 1 で確認 |

## ステップ計画（各ステップの終わりで人のゲート）

1. **契約と feature の確認（読み取り）**: `custom-conditions.feature`、`CreateGameRequest`・`CustomConditions`・`SettingsField`、Kotlin のドメイン（`GameSettings`、`simulateWeek`、設定の種別の判定）を読み、差を一覧にする。
2. **性質テストを先に書く（Red）**: 遅延をパラメータにした `simulate_week` の性質（保存則、決定論、非負、遅延 0 を含む）と、キット準拠のゴールデンの不変。
3. **ドメイン**: `GameSettings` に条件（役割ごとの初期在庫、初期の流れ、3 つの遅延、2 つの単価、公開範囲）を持たせ、`simulate_week` と初期状態（`KitPreset`）をパラメータ化。範囲の検証（すべての誤りを集める）。種別（`KIT`／`CUSTOM`）と変更した項目の判定。domain の行 100%。
4. **符号化・投影**: `GameCreated` の JSON に条件を足す（後方互換）。`game_overview.settings_kind`・`settings_changes`、`game_settings` の投影。
5. **application / HTTP**: `kind: CUSTOM` と `conditions`、`KIT` に `conditions` を付けると 422（カスタムで作成するよう示す）。状態の `settingsKind`・`changedSettings` を実値にする（B2〜B7 は固定の `KIT`・空）。
6. **許可リストと契約テスト**: `custom-conditions.feature` を許可リストへ。契約テストに、カスタムの作成の応答・状態を足す。`@ui` の通過数を記録。
7. **品質ゲート・記録**: `just backend-check`、`just acceptance`、`just ui-acceptance`。`bolt_8_report.md`、`index.md`、`mkdocs.yml`、`docs/log.md`、`apply-okf` と `okf:check`。
8. **コミット・push・CI**（区切りごと。Red の間は push しない）。

## 範囲外

自動確定の動作（B9）、公開範囲の実際の開示（観察者への表示・抑止。B10）、守り（hook・必須ジョブ。別途計画を示して確認）、設計書への反映（まとめて別途）。

## リスク

| # | リスク | 対応 |
| :--- | :--- | :--- |
| R1 | `simulate_week` のパラメータ化が、B1 のゴールデン・性質テストを壊す | 先にゴールデンを固定し、キット準拠の結果が変わらないことを確認してから進める |
| R2 | イベントの JSON の後方互換（既存の `GameCreated`） | 条件が無い JSON をキットの値として読むテストを書く |
| R3 | 初期の流れ（遅延の各段）の初期化が、キットの定義と一般化で食い違う | Kotlin の `KitPreset` と同じ値になることを、キット準拠のテストで固定 |

---

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-22 | 初版作成（草案。人の承認待ち） | claude-code |
