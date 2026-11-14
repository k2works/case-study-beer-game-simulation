---
type: ADR
title: "ADR-010: events を追記専用にし、保持削除を game_roots の連鎖削除 1 回で行う"
description: "events はアプリ用ロールに INSERT と SELECT だけを与えて追記専用とし、保持削除は削除用ロールによる game_roots の 1 回の DELETE（ON DELETE CASCADE）で行う。RetentionSaga は状態の行で持つ。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T08:30:39Z }
---

# ADR-010: events を追記専用にし、保持削除を game_roots の連鎖削除 1 回で行う

`events` はアプリケーションが使う DB ロールに INSERT と SELECT だけを与えて追記専用にする。保持期限後の削除は、別の削除用ロールが `game_roots` を 1 回 DELETE し、`ON DELETE CASCADE` で全表の行を消す。

日付: 2026-11-14

## ステータス

提案中（レビュー待ち）。ただし、保持の起点（作成時）は**暫定**であり、連鎖削除が `events` に DELETE 権限を持たないロールで動くかは**未検証**である（下記）。

## コンテキスト

Kotlin 版では `events` が状態の正本であり、監査の記録を兼ねる（[ADR-002](./002-event-sourcing-and-cqrs.md)）。イベントが書き換えや削除ができると、正本と監査の信頼が崩れる。一方、保持期間（1〜3650 日、既定 90 日）を過ぎたゲームは、`game_id` を持つすべての表（`events`、投影、周辺ストア、冪等記録）から漏れなく消す必要がある（NF-S16、NFR-07）。この 2 つは、「`events` は消せない」と「`events` も消す」という緊張を持つ。

beer-game2 は、`games` を根にした連鎖削除（beer-game2 の ADR-007）で漏れを防いだ。Kotlin 版では `games` が投影になったため、独立した根 `game_roots` を置く（[データモデル](../../design/beer-game-kotlin/data-model.md) 変更 8）。

## 決定

- **`events` は追記専用**とする。アプリケーションが使う DB ロールには INSERT と SELECT だけを与え、UPDATE と DELETE を与えない。守りは権限（GRANT）だけで行い、更新・削除を拒否するトリガーは足さない（トリガーは連鎖削除も止めるため）。
- **保持削除は、`DELETE FROM game_roots WHERE game_id = $1` の 1 回**で行う。`events`・投影・周辺ストア・冪等記録は `game_roots(game_id)` への外部キー（`ON DELETE CASCADE`）で連鎖して消える。削除は、アプリ用ロールと別の**削除用ロール**が行う。
- **`RetentionSaga` は ES にしない**。`deletion_runs`・`deletion_attempts` という状態の行で持つ（プロセスマネージャー。データモデル 変更 7）。純粋な `decide` / `evolve` は定期タスク（`retention` モード）から駆動する。
- `deletion_runs` と `deletion_attempts` は `game_roots` への外部キーを持たない（ゲームのデータが消えた後も再試行の記録として生き残るため）。**完了と同じトランザクションで、この 2 表の行も削除**し、`game_id` を含む行を残さない（AC5.1.4）。証跡は、ゲームを特定できない `deletion_receipts`（鍵付きダイジェストだけ。1 年後に削除）に限る。
- **完了とするのは、連鎖削除が成功したときだけ**。同じ削除 ID で最大 5 回、指数バックオフと揺らぎで再試行する（NF-R11）。
- **保持の起点は、暫定で作成時**（`retention_starts_at`）とする。終了済みのゲームを終了時から数える案（ユーザー代表の提案）は**未決**で、人の確認が要る。作成後、ロビー、保持状態の画面に、削除予定日と「バックアップには削除後も最大 7 日残る」を示す。
- **未検証の事項**: 連鎖削除が、`events` に DELETE 権限を持たないロールで動くかは確認できていない。**B2 の最初のスライドの Red のテスト**で確かめる。

### 代替案

設計書の案の表（データモデル 変更 7）と、本 ADR の決定が避ける方針から取る。

- 論理削除（行を残して削除済みの印を付ける）: 設計書の案の表には無く、保持期限後に `game_id` を持つ行が残る。「削除後に行が残らない」（AC5.1.4、NF-S16）を満たせないため採らない。
- 表ごとの削除、または `retention` ストリーム（イベントストアの別の保持）: 設計書が退けた案（データモデル 変更 7）。表の追加のたびに削除の漏れが生じ、漏れを網羅する検査に頼ることになる。`events` を使った保持の手続き（`retention` ストリーム）は、削除の途中で自分の根拠のイベントが消えるため、状態の行のほうが単純である。

## 影響

### ポジティブ

- 1 回の DELETE で全表が消えるため、漏れが構造的に起きにくい。表が増えても、`game_roots` への外部キーがあれば削除の対象になる。
- `events` が書き換えられないため、監査の信頼が保たれる。
- 削除の再試行と再起動後の復元が、状態の行だけで済む（NF-R12）。

### ネガティブ

- 連鎖削除と追記専用の権限の両立が、実測まで確認できていない（R6）。両立しなければ、`SECURITY DEFINER` の関数または削除用ロールで解決する（リリース計画 R6）。
- 保持の起点が作成時だと、事前に作成した研修では、終了後の振り返りと出力の猶予が短くなりうる。
- バックアップには削除後も最大 7 日残る。

## コンプライアンス

- **B2（最初のスライドの Red）**: 書き込みロールが `game_roots` を DELETE できず、`events` を TRUNCATE できないこと。各ロール（書き込み・読み取り・観察者・削除）が表の所有者でも所有者ロールのメンバーでもないこと。削除ロールが `game_roots` 以外を直接 DELETE できないこと。連鎖削除が `events` に DELETE 権限を持たないロールで動くこと（NF-S20。DB の権限のテスト）。
- **B11**: 削除後に `game_id` を持つ全表に行が残らないことを、`information_schema` による検査で確かめる（AC5.1.*）。完了のトランザクションで `deletion_runs`・`deletion_attempts` が消えること、障害の注入で再試行と復元が働くこと（NF-R11、NF-R12）。
- **B11**: 削除予定日とバックアップの残存期間の表示（M5。人の確認）。
- 保持の起点の確定は、Release 0.2 のリリース条件の確認で行う（開発戦略。局面の移行の確認）。

## 備考

- 著者: claude-code
- 関連 ADR: [ADR-002](./002-event-sourcing-and-cqrs.md)、[ADR-009](./009-observer-access-control.md)、[ADR-006](./006-event-schema-evolution.md)、beer-game2 の [ADR-007](../beer-game2/007-cascade-deletion-without-queues.md)、[ADR-014](./014-h2-for-local-development.md)（権限と連鎖削除は PostgreSQL の統合テストで検証する）
- 参照: [データモデル（保持削除、追記専用の保護、変更 7・8・9）](../../design/beer-game-kotlin/data-model.md)、[非機能要件（NF-S16、NF-S20、NF-R11、NF-R12）](../../design/beer-game-kotlin/non-functional.md)、[バックエンド（保持削除、DB ロール）](../../design/beer-game-kotlin/architecture-backend.md)、[リリース計画（B2、B11、R6）](../../development/beer-game-kotlin/release_plan.md)
