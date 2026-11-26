---
type: Reference
title: "Bolt 1 終了報告 - 基盤・静的解析・縦の最小（Scala 版）"
description: "beer-game-scala の Bolt 1 の結果。完了条件の達成状況、仮説の検証結果、承認ゲートの扱い、人の判断が要る項目、Living Documentation の実施結果、B2 への申し送り。"
tags: [report, plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-26T08:10:00Z }
---

# Bolt 1 終了報告（Scala 版）

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B1（U1。計画は [bolt_1_plan](./bolt_1_plan.md)） |
| 期間 | 2026-11-26（1 セッション。AI の連続実行。計画は 2.5 稼働日） |
| 状態 | **実装と記録は完了。人のゲート（Step 1〜12）の承認は未記録。** コードの全行理解の承認も未記録 |

この報告は実装の事実と、人が判断・検証すべき点を示します。**承認の記録ではありません。** 計画書（リリース計画・開発戦略・B1 計画）自体も、`status: draft` のままです。

## 承認ゲートの扱い

計画は「密」（ステップごとに人が検証）でしたが、セッションの目標（`/goal orchestrating-development U1`）に従い、AI が各ステップの結果を「人の確認待ち」として先へ進めました。`/goal` は承認ではありません。次は**未承認・未実施**です。

- Step 1〜12 のゲート、golden の値の人による確認、コードの全行理解、デモ項目の実操作
- 着手前の判断項目の承認、リリース計画・開発戦略・B1 計画の承認

## 完了条件の達成状況

| 完了条件 | 結果 | 根拠 |
| :--- | :--- | :--- |
| ローカル（H2）で E2E、PostgreSQL（Testcontainers）でも同じ契約 | 達成 | `EventStoreContract` を H2・PostgreSQL 18.6 の両方で実行。`integration` ジョブが緑 |
| 許可リスト（B1 の範囲）の `@api` が green。Undefined・Pending が 0 | 達成（範囲は B3 で 27 シナリオ・155 ステップに拡大） | `./scripts/acceptance.sh` |
| 静的解析: fixture の期待件数一致、違反 0、ベースラインなし、抑制なし | 達成 | `./scripts/check.sh`（WartRemover 14 件・Scalafix 7 件の fixture、層の依存検査） |
| 受入条件の表の全行が成立・不成立の記録つき | **一部** | `@api` 27 シナリオと `@ui` 1 本（AC2.3.1）は成立。それ以外の行の一覧化は未了 |
| 行率の算出スクリプトとテスト、全体行 80% | 達成 | `./scripts/coverage.sh 80` → 86.7%（1104/1272） |
| golden・性質テスト | 達成 | domain のテスト（golden・ScalaCheck・cats-laws） |
| 依存関係の承認と版の記録 | **未承認** | 版は `build.sbt` に記録。承認は下記「人の判断が要る項目」 |
| Living Documentation の実施と結果の記録 | 実施（下記） | |
| 人による全ゲートの承認 | **未記録** | 承認されていないため、記録しない |

## 仮説の検証結果

| 仮説 | 結果 |
| :--- | :--- |
| H2 と PostgreSQL に同じ DDL・同じ契約が通る | 成立。ただし H2 の payload は `text`（PG は `jsonb`）の差を許した（V001・V002 は共通、V003 は PG 専用） |
| `ConnectionIO` の単一トランザクションで、楽観的並行制御（一意制約）が成り立つ | 成立。`uq_events_stream_version` の衝突を `Conflict` に写像 |
| scoverage から行率を算出できる | 成立（XML の `source`・`line`・`invocation-count`・`ignored` を使う自作ツール） |
| 規約違反が静的解析で落ちる | 成立（fixture 14 + 7 件。`.transact(` は `Transactions.scala` だけ許可） |
| 共有の Web（Cucumber-JS + Playwright）が Scala のバックエンドで動く | 成立。AC2.3.1 が緑。原因は、タブ名の Cookie（ADR-020）へのフォールバック欠落だった |

## 設計の簡略化（人の判断が要る）

| 項目 | 内容 |
| :--- | :--- |
| 読み取りモデルの投影表なし | 状態はイベントの再生で復元する。NF-P2・NF-P18 に影響するため、**B12 で再検討** |
| 冪等の再送で Cookie を再発行しない | 最初の応答の本文・状態のみ再生 |
| ProjectionLock・ChangeNotifier・資格の失効 | 未実装（後続の Bolt） |
| NF-P2（性能）の測定 | 未実施。測定するかの判断が必要 |
| OpenAPI の契約テスト、プロジェクトごとのしきい値 | B2 の残り（B2 報告を参照） |

## 人の判断が要る項目（AI が決めていないもの）

1. マイグレーション V001〜V003 の承認（確認必須: データベース・スキーマ）
2. 追加した依存関係の承認（cats-effect・doobie・http4s・circe・Flyway・H2・Testcontainers・cucumber-scala・scala-xml ほか。版は `build.sbt`）
3. 共有資産（`apps/beer-game-features`・`apps/beer-game-web`・`apps/beer-game-contracts`）を読み取り専用で利用する運用
4. 規約の例外（期間の延長 SR9）と `project.md` の Scope Overrides の記録（AI は `project.md` を編集しない）
5. 外部の hook の設定（Living Documentation のリマインド。ユーザー側で適用）
6. 計画・戦略の承認、ADR-001 のレビュー

## Living Documentation（`apply-living-documentation`）の実施結果

| 観点 | 判断 |
| :--- | :--- |
| 書く | 判断の根拠（簡略化の理由、ADR-020 のフォールバック）は、この報告とコードのコメントに残した |
| リンク | 受入条件は共有の Gherkin（`apps/beer-game-features`）にリンクし、複製しない。API の契約は `openapi.yaml` に委ねる |
| 生成 | 用語集・図の自動生成は **B1 では未導入**（B15 で判断）。コードから取れる構造は `docs/design` に手書きで複製していない |
| 書かない | クラス一覧・依存関係図は書かない（`check-deps.sh` が層の依存を検査） |
| 設計文書とコードの複製 | 設計書（`docs/design/beer-game-scala`）との差分: 読み取りモデルの簡略化、H2 の `text` payload。**設計書の更新は未実施**（承認後に反映） |

## 学びと B2 への申し送り

- 共有の Web は、サーバー側の契約（タブ名の Cookie、応答の形）への準拠が前提。他言語版の実装と契約を照合するのが早い。
- `@ui` の残り 26 本は B3 以降の対象。実行すると未実装の API（観察者・保持・エクスポートなど）で落ちる。
- 実績: 計画 2.5 稼働日に対し AI の連続実行は 1 セッション（人の検証時間は含まない）。B2 以降の再調整は、人の検証時間の実績が出てから行う。
