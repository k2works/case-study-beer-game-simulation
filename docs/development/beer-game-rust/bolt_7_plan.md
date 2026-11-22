---
type: Plan
title: "Bolt 7 計画 - 共同担当と共同入力（Rust 版）"
description: "beer-game-rust の Bolt 7 のステップ計画。同一役割への複数人の割り当て、共同入力の競合と再試行、役割の入れ替えと旧担当者の資格の自動失効、契約テストの導入。人の承認待ちの草案。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-22T00:00:00Z }
---

# Bolt 7 計画 - 共同担当と共同入力（Rust 版）

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B7（[リリース計画](./release_plan.md)）。Unit U2 |
| 所要（計画） | 2 稼働日（仮定。契約テストの導入を含めると超える見込み。超える場合は予備 B17 の前に人へ報告） |
| ゲート密度 | **密**（ステップごとに人が検証） |
| アプローチ | 中盤の**インサイドアウト**（ドメイン → application → HTTP）。入口は共有する日本語 Gherkin の許可リスト |
| 状態 | **2026-11-22 にユーザーが「承認」（計画全体。DDL・新規依存は各ステップで確認）。着手済み** |

### ゴール

同じ役割に複数の参加者を割り当てられるようにし（共同担当）、同じ版から 2 人が保存したときの競合と再試行を扱う。開始後の**役割の入れ替え**（旧担当者の資格を自動で失効）を実装する。B6 で承認された**契約テスト**を並行して導入する。

### 確認したい仮説

1. 並行の保存で更新を失わないか（`DecisionConflict` で最新値と保存者を返し、1 人目の入力が残る）。
2. `GameData.participants`（1 人 1 役割の写像）を、同一役割に複数人を持てる形へ変えても、既存のテスト（開始時の写し、不足の役割の判定）が保たれるか。
3. 契約テスト（`jsonschema`・YAML）で、B5・B6・B7 で追加した API の応答の形を、共有する `openapi.yaml` と機械的に照合できるか。

### 対象の受入条件（共有する `features/`）

| ストーリー | 受入条件 | 共有する feature |
| :--- | :--- | :--- |
| US1.2 | AC1.2.4（共同担当、開始条件）、AC1.2.5（一方を別の役割へ移す） | `game-setup/co-assignment.feature`（4 シナリオ） |
| US2.1・2.2 | AC2.1.4（共同担当の同一の見え方、他の役割へは見せない）、AC2.2.3（競合と再試行）、AC2.2.4（共同担当間で値・版・保存者が同じ）、保存回数の共有、確定の確認の競合 | `weekly-play/co-input.feature`（約 12 シナリオ） |
| US3.2 | AC3.2.5（役割の入れ替えと自動失効） | `continuation/credentials.feature` の後半 8 シナリオ（B6 で除外した分） |

## 着手前に人の判断が要る項目

| # | 項目 | 案 |
| :--- | :--- | :--- |
| 1 | **新規依存**: 契約テストの `jsonschema` と YAML パーサ（`openapi.yaml` の読み込み用。開発時のみ） | 2026-11-22 に導入を承認済み。**導入の直前に版を再確認し、`cargo deny` を通す**（通らなければ報告して止める） |
| 2 | **DB スキーマ**: 共同担当の表現。`lobby_participants` は 1 人 1 行で `role` 列を持つため、同一役割に複数行で表せる。スキーマ変更は不要の見込み。入れ替えの記録（`replaced_at`）が要るかは Kotlin 版 V007 を参照 | 変更が要る場合は DDL を示して確認（Step 2 のゲート） |
| 3 | **契約 `openapi.yaml`（共有物）の変更は不要の見込み**。差が出たら Kotlin 版に影響するため、変更前に確認 | 契約どおりに実装する（RU2） |
| 4 | **入れ替えの規則の細部**（開始後、役割なしの参加者を、すでに担当がいる役割へ割り当てる。旧担当者の資格を失効させ、履歴を残す）は Kotlin 版のドメインモデル「役割の入れ替え」に従う | Step 1 で差を一覧にして確認 |

## ステップ計画（各ステップの終わりで人のゲート）

1. **契約と feature の確認（読み取り）**: 上の 3 つの feature、`openapi.yaml` の該当パス（`assignRole`、`decisions`、`state` の `decisionEditor`・`decisionSavedAt`・共同担当の項目）、Kotlin のドメイン（`ReplaceRole`）を読み、差を一覧にする。
2. **スキーマの確認**: 共同担当と入れ替えに DDL が要るかを確認する。要るなら DDL を示して承認を得る。
3. **ドメイン（Red 先）**: `GameData` を、同一役割に複数人を持てる形へ。開始条件、開始後の入れ替え（`RoleReplaced` 相当のイベント）、`DecisionEntry.editor`、`decision_savedAt`。失敗するテストを先に書く。
4. **application / HTTP**: 割り当て（共同担当）、入れ替えで旧担当者の資格を同じトランザクションで失効（`RevokeCredentials` を再利用）、状態の表示に `decisionEditor`・`decisionSavedAt`・共同担当を、開示の規則に従って含める。
5. **共同入力の競合**: `DecisionConflict` に最新値と保存者、競合した保存は回数に数えない、確定の確認の競合（`DecisionsChanged`）。2 つの並行リクエストの統合テスト。
6. **許可リスト**: `co-assignment.feature`、`co-input.feature`、`credentials.feature` の後半を追加し、`@ui` の通過数を記録（`just ui-acceptance`。`co-input-ui` が増える見込み）。
7. **契約テストの導入**: 依存の再確認 → `cargo deny` → 応答の形を `openapi.yaml` のスキーマで検証するテスト（B5〜B7 の API）。CI で実行。
8. **品質ゲート・記録**: `just backend-check`、`just acceptance`、`just ui-acceptance`。`bolt_7_report.md`、`index.md`、`mkdocs.yml`、`docs/log.md`、`apply-okf` と `okf:check`。
9. **コミット・push・CI**（区切りごと。Red の間は push しない）。

## 範囲外

カスタム条件（B8）、自動確定（B9）、観察者（B10）。守り（hook・必須ジョブ）の導入（別途、計画を示して確認）。設計書への反映（`verified` の再確認を伴うため、まとめて別途）。

## リスク

| # | リスク | 対応 |
| :--- | :--- | :--- |
| R1 | `GameData` の形の変更が、開始・投影・符号化のテストを広く壊す | ドメインのテストを先に直し、段階的に移す。イベントの JSON の後方互換（既存の `RoleAssigned` を維持）を確認 |
| R2 | 契約テストのクレートが `cargo deny`（ライセンス・助言）を通らない | 導入前に確認。通らなければ報告して判断を仰ぐ |
| R3 | 2 日に収まらない | 契約テストを分割（B7b）。予備 B17 を使う前に人へ報告 |

---

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-22 | 初版作成（草案。人の承認待ち） | claude-code |
