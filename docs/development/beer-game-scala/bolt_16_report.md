---
type: Reference
title: "Bolt 16 終了報告 - U7 未達 NFR の安全な範囲の解消（Scala 版）"
description: "beer-game-scala の Bolt 16（予備枠。U7 は AI が仮に定義）の結果。Origin 検査・本文 64 KB の上限・Cookie の Secure を実装した。未承認。"
tags: [report, plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-28T00:00:00Z }
---

# Bolt 16 終了報告（Scala 版）

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B16（予備枠。計画は [bolt_16_plan](./bolt_16_plan.md)。**計画は着手前に書いたが、承認は得ていない**） |
| Unit | **U7 はリリース計画に無い。`/goal orchestrating-development U7` を受け、AI が仮に定義した（未承認）** |
| 状態 | **実装・検証は完了。計画・U7 の定義・人のゲートの承認は未記録。Release 1.0 のタグ・承認は行っていない** |

## 完了条件の達成状況

| 対象 | 結果 | 根拠 |
| :--- | :--- | :--- |
| NF-S8 Origin 検査 | 達成 | `HttpPolicy.allowedOrigins`（`ALLOWED_ORIGINS`）。許可か `Host` と同一の Origin 以外は 403 `app.origin_not_allowed`。GET は検査しない。`HttpSpec` |
| NF-P12 本文 64 KB | 一部 | `Content-Length` 超過は 413 `app.payload_too_large`。chunked は未対応 |
| NF-S2 Cookie の Secure | 達成 | staging・production で付ける。`AppConfigSpec`・`HttpSpec` |
| 既存の受け入れ | 緑 | 許可リスト 164 シナリオ・1093 ステップ、`@ui` 27/27（Chromium。`ui-acceptance.sh` に `ALLOWED_ORIGINS` を追加）、`check.sh` 緑 |

## 気づき（記録）

- Origin 検査を入れた直後、`ALLOWED_ORIGINS` が無い `@ui` は 18 シナリオが落ちた（Vite の中継で Origin と Host が一致しないため。設計書の記述どおり）。起動スクリプトに設定を足して解消した。**本番・ステージングの Terraform には `ALLOWED_ORIGINS` を設定していない**（未対応。AWS 未適用のため未確認。設定しないと、独自ドメインの画面からの変更が 403 になる）。
- `EntityLimiter`（http4s）は、直接 `HttpApp` を呼ぶテストでは 413 に変換されず例外になり、テストが固まった。`Content-Length` を自前で検査する方式に変えた。

## 人の判断が要る項目（未承認）

U7 の定義そのもの、Origin・Referer が無い要求を通す点、chunked の本文の上限、本番の `ALLOWED_ORIGINS` の設定（`infra/`）。ほかは [release_readiness.md](./release_readiness.md) のとおり。

## Living Documentation

NFR の判定は [nfr_results.md](./nfr_results.md) を更新した。設計書は変更していない。コードと文書の複製はなし。
