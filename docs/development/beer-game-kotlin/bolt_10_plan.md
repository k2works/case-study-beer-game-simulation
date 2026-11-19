---
type: Plan
title: "Bolt 10 計画 - 結果の出力（Kotlin 版）"
description: "beer-game-kotlin の Bolt 10（Unit U4 の 3 つ目で最後。Release 1.0）のステップ計画。終了後に、進行役が全週・全役割の記録を CSV と JSON で出力する。/goal U4 に基づく自律実行の記録。ゲートは未承認。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-17T15:00:00Z }
---

# Bolt 10 計画 - 結果の出力

> **承認の状態について**: 本書は、ユーザーの `/goal U4`（Unit U4 を完了する）に基づいて、AI が計画を書いたうえで実装した記録です。**判断項目とゲートの個別の承認は、受けていません（すべて未承認）。** 実装の結果は [bolt_10_report](./bolt_10_report.md)。

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B10（[リリース計画](./release_plan.md)）。U4 の 3 つ目（最後） |
| 対象 | AC4.3.1〜4.3.3（US4.3） |
| アプローチ | インサイドアウト。日本語 Gherkin（`@api`、`@ui` 1 件）→ ドメイン（`buildExport`。全域の純粋関数）→ アプリケーション（認可・終了後のみ）→ HTTP・契約 → UI。TDD（Red → Green） |
| 仮説 | 出力は投影にせず、要求時に `week_role_results` と設定の概要から作れる。スキーマ変更（Flyway の新しい版）は要らない |

## 判断項目（AI の提案どおりに進める。未承認）

| # | 項目 | 案 |
| :-: | :--- | :--- |
| 1 | 経路 | `GET /games/{gameId}/exports?format=csv|json`（設計書 `GET /games/:id/exports`。`format` は必須。省略・不正は 422）。新しい投影・表は作らない（`export_packages` は廃止済み） |
| 2 | 認可 | **進行役だけ**。観察者・参加者・無資格・別のゲーム・存在しないゲームは、同じ 403（`app.unauthorized`）。終了前は 409 `game.not_ended`。資格の検査を先に行い、終了の検査は後（資格の無い人に状態を明かさない） |
| 3 | 純粋関数 | `buildExport(settings, results): ExportPackage`（domain。`Either` を返さない全域関数）。`schema_version`・`checksum` も、要求時に算出する。CSV と JSON は同じ行（`ExportRow` の列）から作り、数量・費用が必ず一致する |
| 4 | 含める値 | 設定（種別 `KIT`/`CUSTOM`、キットから変えた項目の名前、確定方式）、全週・全役割の 受注・出荷・発注（意思決定）・週末在庫・週末受注残・週次費用・累計費用。**既存の投影（`week_role_results`・`game_overview`・`game_settings`）から作れる範囲に限る** |
| 5 | 「意思決定」の意味 | 週ごとに確定した各役割の発注量（`ordered`）。beer-game2 の列 `order` に当たる。確定時点の値であり、入力の保存の履歴ではない |
| 6 | 「履歴」の意味 | 週の順に並んだ全週の記録（週・役割・累計費用の推移）と、確定方式（`commitMode`）。**イベント履歴（入力の保存・代理入力・停止・再開の時刻）は含めない**: 投影から作れず、設計書の `buildExport(settings, weekRoleResults)` の入力にもない。表示名・資格・参加コードを含まないこと（NF-S14）を、イベントの再読み込みなしに保つ。入力者の種別と時刻の出力は、将来の拡張の検討（報告書の未実施に記録） |
| 7 | 列 | CSV: `schema_version, game_id, settings_kind, settings_changes, commit_mode, week, role, orders, shipped, ordered, ending_inventory, ending_backlog, weekly_cost_minor, cumulative_cost_minor`。1 行 = 1 週 × 1 役割（週の昇順、役割は上流から下流）。`settings_changes` は `;` 区切り。beer-game2 の `order`→`ordered`、`received` は投影に無いため含めない |
| 8 | JSON | `{schemaVersion, gameId, finalWeek, settings:{kind, changes[], commitMode}, records:[{week, role, orders, shipped, ordered, endingInventory, endingBacklog, weeklyCostMinor, cumulativeCostMinor}]}`。項目名は API の他の応答（camelCase）に合わせる |
| 9 | スキーマ版 | `beer-game-kotlin.export.v1`。出力の形を変えたら上げる。CSV は各行の列、JSON は `schemaVersion` と、応答ヘッダー `X-Export-Schema-Version` に記録する |
| 10 | チェックサム | **応答の本文（UTF-8 のバイト列）の SHA-256**（小文字の 16 進）。応答ヘッダー `X-Export-Checksum` に `sha256-<hex>` で返す。本文に埋め込まない（埋め込むと自己参照になる）。形式ごとに別の値 |
| 11 | CSV の安全 | RFC 4180（CRLF、`,`・`"`・改行を含む値を `"` で囲み、`"` は二重）。文字列の列は、先頭が `=`・`+`・`-`・`@`・タブ・CR のとき、先頭に `'` を付けて、表計算の数式として解釈させない（OWASP の CSV Injection の対策）。数値の列は、数値から書くので影響がない |
| 12 | 部分的な出力 | 本文は、全体を組み立ててから 1 回で返す（ストリーミングしない）。投影の欠け（終了済みなのに `最終週 × 4` 件の行が無い）・読み取りの失敗は、本文を返さず、既存の失敗の写像（500 `app.internal`、problem+json）にする（AC4.3.3） |
| 13 | ヘッダー | `Content-Type: text/csv; charset=utf-8` または `application/json; charset=utf-8`、`Content-Disposition: attachment; filename="beer-game-<gameId>.csv|json"`。`Cache-Control: no-store`（全応答に既存） |
| 14 | 性能 | 50 週 × 4 役割（200 行）の生成を単体で確かめる（NF-P9 の p95 30 秒の本計測は B15） |
| 15 | 画面 | S08（振り返り）に「CSV を出力」「JSON を出力」のボタン。注記「設定・役割別の値・意思決定を含みます」。取得は fetch（資格の Cookie を送る）→ Blob → `a[download]`。失敗は `role="alert"`（相関 ID つき） |
| 16 | 出力の対象 | 振り返りは参加者・観察者にも開くが、出力のボタンは進行役にだけ出す（権限の無い人にボタンを見せない。サーバーは 403） |
| 17 | スキーマ変更 | なし（Flyway の新しい版は足さない） |

## ステップ

1. 計画書（本書）と受入シナリオ（`features/export/*.feature`）を書き、Red にする
2. ドメイン `buildExport`（ゴールデン・性質テスト：CSV と JSON の一致、数式の無効化、RFC 4180）
3. アプリケーション `Ports.export`（認可・終了後のみ・欠けの検出）
4. HTTP（ルート、`ProblemTexts`、`openapi.yaml`）と契約テスト（`text/csv` の応答に対応）
5. 画面（S08 の出力ボタン。コンポーネントのテストを先に書く）、`@ui` 1 件
6. 全検査、報告書、`release_plan.md` の進捗表

## 更新履歴

| 日付 | 内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-17 | `/goal U4` に基づく自律実行のため、計画を書いて実装した。**判断項目・ゲートは未承認** | claude-code/claude-sonnet-5-5 |
| 2026-11-19 | ユーザーが、判断項目とゲートを承認した（指示: 「Boltゲートの承認」。範囲の選択: U3（B7・B8）・U4（B4・B9・B10）・U5（B11〜B14）・U6（B15）。内容の選択: 「判断項目とゲートのみ」）。判断項目は AI の提案どおりの決定として承認された（入力の保存の履歴を出力に含めない判断項目 6 を含む）。**この承認に含まれない**: デモ項目の人の実操作、コードの全行理解、AWS への適用（別の承認ゲート）。NF-P9 の p95 の本計測は B15 | user（記録: claude-code/claude-sonnet-5-5） |
