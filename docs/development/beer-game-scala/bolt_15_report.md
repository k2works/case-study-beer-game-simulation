---
type: Reference
title: "Bolt 15 終了報告 - 仕上げ（Release 1.0 の準備）（Scala 版）"
description: "beer-game-scala の Bolt 15 の結果。セキュリティヘッダー、@ui 27 シナリオのブラウザ行列、実 PostgreSQL の性能計測、NFR 検証表、Release 1.0 の準備状況。U6 の完了。AWS には適用していない。"
tags: [report, plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-28T00:00:00Z }
---

# Bolt 15 終了報告（Scala 版）

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B15（U6。計画は [bolt_15_plan](./bolt_15_plan.md)。**計画は着手前に書いたが、承認は得ていない**） |
| 期間 | 2026-11-28（`/goal orchestrating-development U6`） |
| 状態 | **実装・計測・記録は完了。Release 1.0 のタグ・承認は行っていない。AWS には適用していない。計画・人のゲートの承認は未記録** |

承認の記録ではありません。`/goal` は承認ではありません。

## 完了条件の達成状況

| 完了条件 | 結果 | 根拠 |
| :--- | :--- | :--- |
| X-5 全応答のセキュリティヘッダー | 達成 | `Routes.app` が全応答（成功・拒否・存在しない経路）に CSP・HSTS・nosniff・Referrer-Policy・Cache-Control を付ける。許可リストの `security-baseline.feature`、`HttpSpec` |
| X-3 ログに秘密を残さない | 達成（弱い） | ログの記録と EMF を検査。ログの型が秘密を持てない構造上の保証であり、検査としては弱い |
| `@ui` 全 27 シナリオ | 達成 | Chromium・Firefox・WebKit の 3 つとも 27/27（183 ステップ）。共有の web は変更していない |
| 実 PostgreSQL の性能計測 | 実測 | `PerformanceMeasurementSpec`（`BGS_MEASURE=1`）。15 ゲーム並行・最終週 50 で 5xx 0 件、確定から反映 p95 1388 ms（上限 4 秒）、`saveDecision` p95 856 ms。**手元・インプロセス・1 回** |
| NFR 検証表 | 達成 | [nfr_results.md](./nfr_results.md)。84 件: 達成 23・一部 35・未測定 8・定義のみ 8・適用外 4・未達 4・未実施 2 |
| Release 1.0 の準備状況 | 達成 | [release_readiness.md](./release_readiness.md) |
| 許可リスト 100% | **定義が未決** | 外れた 8 件の扱いは人の判断 |
| ブラウザ行列（Edge・実機 Safari・スクリーンリーダー） | **未実施** | 環境が無い |

## 受け入れの結果

- 共有 Gherkin（許可リスト）: 164 シナリオ・1093 ステップ緑。
- `./scripts/check.sh`: 緑。`HttpSpec` にヘッダーの単体テストを追加。
- 行カバレッジ: 全体 89.3%（80）・domain 98.1%（90）・application 92.9%（85）。
- PostgreSQL の統合テスト（`PostgresEventStoreSpec` 7 件、`PerformanceMeasurementSpec` 小規模 2 件）: 緑。
- CI: 下の「検証」を参照。

## 人の判断が要る項目（**未承認**）

[release_readiness.md](./release_readiness.md) の第 2 節に一覧。特に、(1) 許可リスト 100% の定義、(2) 指標を出していないアラーム（`main-operation-stall` の誤報）、(3) NF-S8・NF-S18 の未達。

## TDD の逸脱の記録

`PerformanceMeasurementSpec` は計測であり、Red を先に確認する性質のものではない（落ちる閾値は NF-P2 の上限だけ）。セキュリティヘッダーの単体テスト（`HttpSpec`）は、実装と受け入れのシナリオの後に書いた。

## Living Documentation

NFR の定義は設計書、計測の手順はテストが正で、報告書へは複製していない。用語集・図の生成は未導入。設計文書とコードの複製はなし。計測の数値は実行のたびに変わるため、`target/` の出力が正で、表は 1 回の記録。

## 検証

CI: コミット `b8cbe8c6` で 3 ジョブ（check・integration・acceptance）緑。
