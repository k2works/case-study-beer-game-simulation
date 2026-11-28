---
type: Plan
title: "Bolt 16 計画 - U7 未達 NFR の安全な範囲の解消（Scala 版）"
description: "beer-game-scala の Bolt 16（予備）のステップ計画（草案）。/goal U7 の指示に対し、U7 をリリース計画に無い Unit として AI が仮に定義し、NF-S8・NF-P12・NF-S2 を解消する。人の承認待ち。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-28T00:00:00Z }
---

# Bolt 16 計画（Scala 版）

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B16（リリース計画の予備枠を使う） |
| Unit | **U7（リリース計画に無い。`/goal orchestrating-development U7` の指示を受け、AI が仮に定義した）** |
| 状態 | **承認済み（2026-11-28、ユーザーの「承認」。範囲は、U7 の定義と B16 の計画・成果。下の注記）** |

> U7 はリリース計画（U1〜U6）に存在しません。人の定義を待たず、`release_readiness.md` の判断項目のうち、**設計判断が小さく、設計書に記述がある**ものだけを実施します。承認は得ていません。

## ゴール

NFR 検証表の未達・一部のうち、次の 3 件を解消する。

| ID | 内容 | 方針 |
| :--- | :--- | :--- |
| NF-S8 | 変更系の Origin（または Referer）検査 | `HttpPolicy.allowedOrigins`（環境変数 `ALLOWED_ORIGINS`）。許可した Origin か、`Host` と同一の Origin だけ通す。それ以外は 403 `app.origin_not_allowed`。Origin・Referer が無い要求は通す（ブラウザ以外の呼び出し） |
| NF-P12 | 本文 64 KB の上限 | 超えたら 413（`EntityLimiter`。新しい依存なし） |
| NF-S2 | Cookie の `Secure` | 本番相当（staging・production）で付ける。ローカルの HTTP の開発・@ui は付けない |

## 対象外（人の判断が要る。引き続き未承認）

NF-S18（観察者の DB ロール分離）、NF-O12・O13 と動かないアラームの指標出力、依存関係の脆弱性検査、OpenAPI 契約テスト、投影表。

## ステップ

- [x] 計画書（本書）
- [x] `HttpSpec` に 4 件のテスト（Origin・GET・64 KB・Secure）を先に書き、Red を確認
- [x] `HttpPolicy` と `Routes.httpApp(env, policy)`、`AppConfig` の `ALLOWED_ORIGINS`・`Secure`（staging・production）、`Main` の接続
- [x] `AppConfigSpec`、`check.sh`・受け入れ・カバレッジ、`@ui`（Origin 検査が Vite の中継で落ちないこと）
- [x] `nfr_results.md`・`release_readiness.md` の更新、報告書、コミット、push、CI

## 完了条件

- 上の 3 件の判定が「達成」になり、既存の許可リスト・`@ui` が緑のまま
- Origin・Referer の無い要求を通す点（ブラウザ以外の呼び出しを許す）を、判断項目として報告に記録

## 承認の記録

2026-11-28、ユーザーが「承認」と返答した。AI は、直前の報告で人の判断を求めた次の範囲への承認として記録する（範囲が違えば訂正する）。

- 承認した: **U7 の定義**（B16 予備枠で NF-S8・NF-P12・NF-S2 を解消）、B16 の計画、B16 の成果（Origin・Referer の無い要求を通す点、chunked に上限を掛けない点を含む）
- 承認していない（未承認のまま）: Release 1.0 のタグ・承認、B1〜B15 の計画・ゲート、[release_readiness.md](./release_readiness.md) の他の項目、本番の `ALLOWED_ORIGINS` の設定、AWS への適用
