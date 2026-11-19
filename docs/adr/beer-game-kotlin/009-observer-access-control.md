---
type: ADR
title: "ADR-009: 観察者を DB ロールと接続プールで分け、読める表を 3 表に限る"
description: "観察者は専用の DB ロールと接続プールで問い合わせ、読める表を game_overview、session_overview、week_team_totals の 3 表に限る。参加コードは別の表に分ける。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T08:15:50Z }
---

# ADR-009: 観察者を DB ロールと接続プールで分け、読める表を 3 表に限る

観察者の問い合わせは、専用の DB ロールと別の接続プールで行い、読める表を `game_overview`（参加コードなし）、`session_overview`、`week_team_totals` の 3 表に限る。参加コードは `game_join_codes` に分離し、観察者には SELECT を与えない。`week_team_totals` は、役割別の値を持たない。

日付: 2026-11-14

## ステータス

提案中（レビュー待ち）

## コンテキスト

学習の目的上、各役割は他の役割の在庫・受注残・意思決定値と将来の需要を知ってはならない。観察者には、チーム全体の様子だけを見せる（BR-17、NF-S18）。さらに、観察者が参加コードを得ると、参加者として加われてしまう。

beer-game2 は、観察のたびに `week_role_results` を `SUM` して返していた。この形は、観察者の問い合わせが役割別の行に到達できるため、実装の誤りが直接の漏えいになる。Kotlin 版は ES + CQRS で、読み取りは投影の表を SQL で読む。表を分ければ、データベースの権限で分離できる（[データモデル](../../design/beer-game-kotlin/data-model.md)）。レビューでは、参加コードの表の分離（M1）と、接続プールの配線の確認（H13）が指摘された。

## 決定

- **観察者のための DB ロールと接続プールを、他の用途から分ける。** 用途別のロール（書き込み、読み取り、観察者、削除、所有者）を持つ（インフラ設計 ID5）。
- **観察者のロールが SELECT できるのは 3 表だけ**: `game_overview`（参加コードなし）、`session_overview`（`submitted_role_count` を含み、値は含めない）、`week_team_totals`。
- **参加コードは `game_join_codes` に分離する。** 読むのは、進行役と、参加の問い合わせ（参加コードの照合）だけ。観察者には SELECT を与えない。
- **`week_team_totals` は、役割別の値を持たない。** 確定時にチーム合計を別の行として保存し、観察者の読み取りが役割別の行に触れないようにする。公開範囲と、寄与者数による抑止（`contributors < 2` なら合計を出さない）は、問い合わせの層（`Disclosure`）で行う。
- **確かめる方法**: 権限の否定テストと、接続プールの配線テスト（観察者の HTTP の経路を実 DB で通し、問い合わせの `current_user` が観察者ロールであることの検査）。

設計書の該当節: [データモデル](../../design/beer-game-kotlin/data-model.md)（読み取りの規則、観察のための `week_team_totals`）、[インフラ設計](../../design/beer-game-kotlin/architecture-infrastructure.md)（データベースの接続、ID5）、[非機能要件](../../design/beer-game-kotlin/non-functional.md)（NF-S18）。

### 代替案

- アプリケーションの層だけで制限する（データベースの権限は 1 つのロール。インフラ設計 ID5 の案 B）: 構成が単純。しかし、アプリのバグが直接の漏えいと、イベントの書き換えにつながる。
- 観察者に、役割別の表を元にしたビューを使う: 設計書に、この案の検討の記載はなく、却下の理由は設計書では確認できない（本 ADR の推論として、ビューの元の表への権限が要り、役割別の値への到達の経路が残る点を挙げるにとどめる。要確認）。
- 観察のたびに `week_role_results` を `SUM` する（beer-game2。データモデルの案 B）: 行が 1 種類で単純。観察者の問い合わせが役割別の値に到達できてしまい、実装の誤りが直接の漏えいになる。

## 影響

### ポジティブ

- アプリのバグがあっても、役割別の値と参加コードが漏れにくい（最小権限）。
- 観察者向けの読み取りが、役割別の行に触れない。
- 観察者が参加コードを得て、参加者として加われない。

### ネガティブ

- 秘密（資格情報）と接続プールが増え、運用の手間が増える。
- 投影の表が 1 つ増え、確定時に書く内容が増える。
- 書き込み用のプールを観察者の経路に誤って渡す、配線の設定ミスは、権限の否定テストだけでは検出できない。配線テストが要る。

## コンプライアンス

- B1: 観察者向けの権限（001〜005 のマイグレーションに含める）を作る。観察者のロールの権限の否定テスト（3 表だけに SELECT があり、`game_join_codes` を含む他の表に無いこと）は、最初のスライドの Red のテストで確かめる（データモデルの未決事項。[テスト戦略](../../design/beer-game-kotlin/test-strategy.md) の観察者の権限）。
- B9（観察者）: 観察用の招待、観察（公開範囲、抑止）、観察者の権限を実装する。AC1.3.*、AC4.1.* として、他役割の値、将来の需要、参加コードが取得できないことの否定テストを置く。観察者の接続プールの配線テスト（`current_user` の検査。H13）を、実 DB の統合テストに置く。
- `Disclosure` のユニットテスト: 寄与者が 2 未満なら合計を返さない。観察者向けの投影の型が、役割別の値を持たない。
- 毎回の CI: NF-S18 の認可の行列テストと、観察者の DB ロールの権限のテスト。

## 備考

- 著者: claude-code
- 関連 ADR: [ADR-002](./002-event-sourcing-and-cqrs.md)、[ADR-003](./003-synchronous-projections.md)、[ADR-010](./010-retention-deletion-with-append-only.md)
- 参照: [データモデル](../../design/beer-game-kotlin/data-model.md)、[インフラ設計](../../design/beer-game-kotlin/architecture-infrastructure.md)、[テスト戦略](../../design/beer-game-kotlin/test-strategy.md)、[リリース計画](../../development/beer-game-kotlin/release_plan.md)、[設計レビュー](../../review/beer-game-kotlin/design_review_20261114.md)（M1、H13）
