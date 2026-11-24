---
type: Plan
title: "Bolt 12 計画 - 保持と削除（Rust 版）"
description: "beer-game-rust の Bolt 12 のステップ計画。保持方針、期限検出と削除の手続き（RetentionSaga）、game_roots の連鎖削除、受領記録、保持状態の API。DDL（マイグレーション 0009）の案を含む。人の承認待ちの草案。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-22T00:00:00Z }
---

# Bolt 12 計画 - 保持と削除（Rust 版）

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B12（[リリース計画](./release_plan.md)）。Unit U5 |
| 所要（計画） | 2 稼働日（仮定） |
| ゲート密度 | **密**（ステップごとに人が検証。**DDL の承認が先**） |
| 状態 | **2026-11-22 にユーザーが「承認」（計画と DDL の案（0009）。DDL の全文は実ファイルで示す）。着手済み** |

### ゴール

ゲームの保持期間（作成時に指定。未指定は 90 日）に基づき、期限に達したゲームを `game_roots` の連鎖削除で消す。失敗したら何も消さず、最大 5 回、指数バックオフで再試行する。削除後は、そのゲームの ID を含む行が**どの表にも残らない**。受領記録は、ゲームを特定しない形（ゲームの ID の鍵付きダイジェストだけ）で残し、1 年後に消す。進行役だけが保持状態を読める。

### 確認したい仮説

1. `DELETE FROM game_roots WHERE game_id = $1` の 1 回で、イベント・投影・周辺ストア・冪等記録が連鎖して消えるか（B2 で連鎖は実測済み。**新しい表を足しても、`game_id` を持つ全表に行が残らないこと**を、表の一覧から機械的に検査できるか）。
2. 削除の手続き（RetentionSaga）が、途中で失敗しても、再試行で最終的に一度だけ削除されるか（二重に実行しても壊れないか）。
3. 削除ロール（`beergame_deleter`）の最小権限で、連鎖削除が動くか（0006 の注記は、実測済みと書く）。

### 対象の受入条件（共有する `features/retention/`）

| ストーリー | 受入条件 | feature |
| :--- | :--- | :--- |
| US5.1 | AC5.1.1（保持日数の既定 90・指定）、AC5.1.2（期限で削除・実行結果・期限前は削除しない・別のゲームを巻き込まない）、AC5.1.3（失敗の再試行・次の試行の時刻・5 回で打ち切り）、AC5.1.4（ID を含む行が残らない）、AC5.1.5（バックアップの残る期間） | `retention.feature`（約 10 シナリオ） |

`retention-ui.feature` は、`web/` が動くかの確認として、通る数を記録する。

## 着手前に人の判断が要る項目

| # | 項目 | 案 |
| :--- | :--- | :--- |
| 1 | **DDL（マイグレーション 0009）** | 下記。Kotlin 版 V006（共通）・V103（GRANT）と同じ内容。`retention_policies`（`game_roots` へ外部キー、連鎖削除の対象）、`deletion_runs`・`deletion_attempts`（外部キーなし。削除後も再試行の記録が残る。完了の同じトランザクションで行も消す）、`deletion_receipts`（ゲームを特定しない） |
| 2 | **新規依存** | なし（見込み。時刻は `Env`、乱数は不要、受領記録のダイジェストは既存の HMAC） |
| 3 | **`retention` の起動モード** | `beergame-app retention`（1 回実行して終了。定期の起動は運用側。B15 の定義）。設計の起動モード 6 つのうち、いま未実装のもの |
| 4 | **保持の起点** | 暫定で作成時（Kotlin 版の M5 と同じ。人の確認が要る） |
| 5 | **契約 `openapi.yaml`（共有物）の変更** | 不要の見込み（`GET /games/{id}/retention`・`Retention` は定義済み） |

### DDL の案（0009。承認後に作る）

```sql
CREATE TABLE retention_policies (
    game_id uuid NOT NULL, retention_days integer NOT NULL,
    retention_starts_at timestamptz NOT NULL, delete_after timestamptz NOT NULL,
    CONSTRAINT pk_retention_policies PRIMARY KEY (game_id),
    CONSTRAINT fk_retention_policies_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE,
    CONSTRAINT ck_retention_policies_days CHECK (retention_days BETWEEN 1 AND 3650),
    CONSTRAINT ck_retention_policies_period CHECK (delete_after > retention_starts_at)
);
CREATE INDEX ix_retention_policies_due ON retention_policies (delete_after, game_id);
CREATE TABLE deletion_runs (deletion_id uuid PK, game_id uuid NOT NULL UNIQUE, status text CHECK (PENDING|IN_PROGRESS|FAILED|COMPLETED),
    attempt integer >= 0, requested_at timestamptz, next_attempt_at timestamptz, last_failure_code text);
CREATE TABLE deletion_attempts (deletion_id uuid FK deletion_runs ON DELETE CASCADE, attempt integer >= 1, started_at, failure_code, PK (deletion_id, attempt));
CREATE TABLE deletion_receipts (deletion_id uuid PK, game_reference_digest text CHECK length 64, outcome text CHECK COMPLETED,
    recorded_at, expires_at CHECK expires_at > recorded_at);
CREATE INDEX ix_deletion_receipts_expiry ON deletion_receipts (expires_at);
-- GRANT: beergame_writer ← retention_policies の SELECT/INSERT/UPDATE/DELETE。beergame_reader ← retention_policies・deletion_runs の SELECT。
-- beergame_deleter ← retention_policies の SELECT、deletion_runs・deletion_attempts の SELECT/INSERT/UPDATE/DELETE、deletion_receipts の SELECT/INSERT/DELETE。
```

（全文は、Kotlin 版 V006・V103 と同じ。承認のあと、実ファイルとして示す。）

## ステップ計画（各ステップの終わりで人のゲート）

1. **契約と feature の確認（読み取り）**: `retention.feature`、Kotlin の `RetentionSaga`・`RetentionHarness`（時計と失敗の注入）を読み、差を一覧にする。
2. **DDL の承認**: 上の案を、承認後にマイグレーション 0009 として作る。
3. **ドメイン**: 保持日数の検証（既存の `RetentionDays`）、期限の導出（作成時の `retention_starts_at` + 日数）、削除の手続きの純粋な判断（`decide_deletion`: 期限・状態・試行回数・次の試行の時刻・指数バックオフ。5 回で打ち切り）。性質テスト。domain の行 100%。
4. **投影**: `GameCreated` で `retention_policies` に書く。
5. **application**: 期限検出 → 削除の実行（`DELETE FROM game_roots`。同じトランザクションで `deletion_runs`・`deletion_attempts` を消し、受領記録を書く）→ 失敗時の記録と次の試行の時刻。時計・失敗の注入を `Env` と、削除の実行のポートで行う。
6. **HTTP・起動モード**: `GET /games/{id}/retention`（進行役だけ）。`beergame-app retention`（1 回実行して終了）。
7. **許可リストと契約テスト**: `retention.feature` を許可リストへ。**表の一覧（`information_schema`）から、`game_id` を持つ全表に行が残らないこと**を機械的に確認するテスト。契約テストに `Retention` を足す。`@ui` の通過数を記録。
8. **品質ゲート・記録**: `just backend-check`、`just acceptance`、`just ui-acceptance`。`bolt_12_report.md`、`index.md`、`mkdocs.yml`、`docs/log.md`、`apply-okf` と `okf:check`。
9. **コミット・push・CI**（区切りごと）。

## 範囲外

投影の再構築・整合検査（B13）、観測・アラーム（B14）、本番の定義・定期の起動（B15）、守りの導入（別計画）。

## リスク

| # | リスク | 対応 |
| :--- | :--- | :--- |
| R1 | 新しい表の `game_roots` への外部キー漏れで、削除後に行が残る | 表の一覧から `game_id` 列を持つ表を機械的に検査（Step 7） |
| R2 | 削除ロールの権限不足（連鎖削除の子の DELETE） | 0006 の記述（所有者の権限で参照整合性のトリガーが動く）を、削除ロールで実測する |
| R3 | 再試行の時刻に依存するテストが不安定 | 時計を注入し、実時間を待たない |

---

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-22 | 初版作成（草案。DDL の案を含む。人の承認待ち） | claude-code |
