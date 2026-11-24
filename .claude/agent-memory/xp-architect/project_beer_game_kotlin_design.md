---
name: project-beer-game-kotlin-design
description: beer-game-kotlin（beer-game2 の Kotlin + ES/CQRS 版）の設計書は 2026-11-14 時点で draft・コードなし。初回レビューで指摘した構造的リスクの要点
metadata:
  type: project
---

docs/design/beer-game-kotlin/ は beer-game2 を正本として Kotlin（Ktor + Arrow）・イベントソーシング + CQRS で再設計した設計書群（2026-11-14 時点 draft、実装なし）。

**Why:** ユーザーの方針で、状態の履歴を学習素材・監査として残すため ES を採用。docs/reference/関数型プログラミングガイド_Kotlin編.md 準拠が前提。

**How to apply:** 再レビュー時は、初回（2026-11-14）に指摘した次の点が解消されたかをまず確認する。
- 冪等記録の照合が decide（認可）より前にあり、失効した操作者の再送が成功応答を受け取る（beer-game3 で学んだ「認可を再送の照合より先に」と同種）
- 追記の一意制約以外の 23505（冪等記録の PK、作成の部分一意索引）が再試行対象外で 500 になる
- CommitWeek の If-Match が session ストリームの版で、参加者の保存だけで StaleVersion になる（UI は「確定済み」と表示）
- 分離レベル・Left 時の ROLLBACK・コルーチンのキャンセル時のトランザクション扱いが未記述
- 文書間の未決事項の取り残し（Flyway、Logback、OpenAPI、DomainError.code、JSON 方式）
関連: [[beer-game3-setup]]
