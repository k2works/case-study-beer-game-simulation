---
type: Design
title: "UI 設計 - ビールゲームシミュレーション（Rust 版）"
description: "Rust 版の UI 設計。画面・遷移・画面イメージ・インタラクション・アクセシビリティは beer-game2 と beer-game-kotlin の UI 設計をそのまま正本とし、Rust のバックエンド（axum・tokio・sqlx）が UI に与える影響（エラー応答の形、キャンセル安全性と再送、SSE、セッションの Cookie）だけを整理した差分の文書。"
tags: [design]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-19T08:32:31Z }
---

# UI 設計 - ビールゲームシミュレーション（Rust 版）

## 概要

本書は、beer-game-rust の UI 設計を定めます。**結論: 利用者が見る画面は、beer-game-kotlin（および beer-game2）と変わりません。** バックエンドが Rust になっても、API の契約（`openapi.yaml`、エラーの `code`、problem+json、`versions` だけの応答、`If-Match`、SSE の版の通知）が同じなら、画面・遷移・画面イメージ・インタラクション・アクセシビリティは同じです（[ADR-001](../../adr/beer-game-rust/001-rust-version-of-beer-game-kotlin.md)）。**`docs/` を設計の正本**とします。

このため、本書は **UI の設計を複製しません**。画面の正本は次のとおりです。

| 内容 | 正本 |
| :--- | :--- |
| 画面一覧、画面遷移、遷移の条件、表示名、OOUI | [Kotlin 版の UI 設計](../beer-game-kotlin/ui-design.md)（beer-game2 を引き継ぎ、ES + CQRS の影響を反映済み） |
| 画面イメージ（S02〜S10 の salt 図 14 枚）、確認ダイアログ | 同上 |
| インタラクション（保存直後の表示、競合の種類と表示、エラーの `code` と表示の辞書、結果が不明なとき、画面の状態） | 同上 |
| アクセシビリティ（WCAG 2.2 AA） | 同上 |

### 本書の位置づけと確認の範囲

- **本書で確認したこと**: Kotlin 版の UI 設計の全体を読み、**Rust の実装が UI の契約に影響しうる箇所**を洗い出しました（下の「Rust 版のバックエンドが UI に与える影響」）。画面そのものは、コードを動かして確認していません（Rust 版の実装がまだ無いため）。
- **確認していないこと**: 下の影響の表の「検証」の列はすべて、B1 以降で確かめる計画です。
- **UI 設計の複製をしない理由**: 画面イメージ 14 枚と遷移を 2 つの文書に持つと、片方だけが更新されて食い違います（Kotlin 版・beer-game2 の間でも、変更表の管理が要った）。フロントエンドの実装（`web/`）が共有されるなら、設計文書も 1 か所に持つのが自然です（設計判断 RU1）。
- Kotlin 版の実装の経緯（B5・B15 の注記）は引き継ぎません。Kotlin 版の未決事項は、本書の未決事項に引き継ぎます。

## 画面一覧と遷移

画面の ID と URL を、参照用に示します（内容は Kotlin 版が正本）。

| ID | 画面 | URL | 利用者 | ユースケース |
| :--- | :--- | :--- | :--- | :--- |
| S01 | はじめる | `/` | 全員 | UC-01、UC-02 |
| S02 | ゲーム作成 | `/new` | 進行役 | UC-01 |
| S03 | 参加・復帰 | `/join` | 参加者、進行役 | UC-02、UC-14 |
| S04 | ロビー | `/games/:id/lobby` | 進行役、参加者 | UC-02〜UC-04、UC-16 |
| S05 | プレイ | `/games/:id/play` | 参加者 | UC-05〜UC-07 |
| S06 | 進行役のコンソール | `/games/:id/console` | 進行役 | UC-08〜UC-10 |
| S07 | 観察 | `/games/:id/observation` | 進行役、参加者、観察者 | UC-13 |
| S08 | 振り返り | `/games/:id/review` | 全員（終了後） | UC-11、UC-12 |
| S09 | 保持状態 | `/games/:id/retention` | 進行役 | UC-15 |
| S10 | 観察者の参加 | `/observe` | 観察者 | UC-13、UC-16 |
| S11 | ヘルプ | `/help` | 全員 | — |

```plantuml
@startuml
title 画面遷移（Rust 版。beer-game2・Kotlin 版と同じ）

state "S01 はじめる" as Welcome
state "S02 ゲーム作成" as Create
state "S02 作成完了" as Created
state "S03 参加・復帰" as Join
state "S10 観察者の参加" as ObserverJoin
state "S04 ロビー" as Lobby
state "S05 プレイ" as Play
state "S06 進行役のコンソール" as Console
state "S07 観察" as Observation
state "S08 振り返り" as Review
state "S09 保持状態" as Retention
state "S11 ヘルプ" as Help

[*] --> Welcome
Welcome --> Create : 「ゲームを作る」
Welcome --> Join : 「参加・復帰」
Welcome --> ObserverJoin : 「観察者として参加」
Welcome --> Help : 「ヘルプ」
Create --> Create : 検証エラー（入力を保持）
Create --> Created : 作成成功
Created --> Lobby : 「ロビーへ」
Join --> Join : 失敗（入力を保持）
Join --> Lobby : 参加成功（準備中）
Join --> Play : 復帰（進行中の参加者）
Join --> Console : 復帰（進行中の進行役）
ObserverJoin --> ObserverJoin : 招待が無効
ObserverJoin --> Observation : 招待が有効
Lobby --> Play : 参加者: 開始
Lobby --> Console : 進行役: 「開始する」
Play --> Observation : 「観察を見る」
Console --> Observation : 「観察を見る」
Console --> Retention : 「保持状態を見る」
Play --> Review : 終了後
Console --> Review : 終了後
Observation --> Review : 終了後
Retention --> Console : 「戻る」
Review --> [*]
@enduml
```

遷移の条件（検証エラーはすべて集めて一度に示す、資格が有効なら状態に応じた画面へ、権限の無い URL は S03 へ誘導する、など）は Kotlin 版と同じです。**Rust 版でも「検証の誤りはすべて集めて 422 で返す」**ため（[ドメインモデル](./domain-model.md) の `collect`）、S02 の「誤りを一度に示す」振る舞いは変わりません。

## Rust 版のバックエンドが UI に与える影響

UI は API の契約にだけ依存します。Rust の実装が**契約から外れる可能性のある箇所**を、UI の側から列挙します。いずれも、契約テスト（[テスト戦略](./test-strategy.md)）と E2E で、契約どおりであることを確認します。

| # | UI が前提にしていること | Rust 版で起きうる逸脱 | 対策・検証 |
| :--- | :--- | :--- | :--- |
| 1 | **エラーは必ず problem+json**（`type`、`code`）。画面の辞書の鍵は `code` | axum が自動で返す応答（本文の解析の失敗、不正な Content-Type、経路なし、メソッド違い、サイズ超過）や、tower の層が返す応答（タイムアウト、負荷の制限）は、**既定では problem+json にならない**可能性がある（**既定の応答の形は未確認**） | **すべての失敗を `AppFailure` の写像（problem+json）に通す**。axum の拒否（rejection）と tower の層のエラーを、`request.*`・`validation.invalid_input`・`app.*` の `code` に写す。契約テスト「実装の `code` の全体と仕様の一致」と「ルートの網羅」で検証（[バックエンドアーキテクチャ](./architecture-backend.md)） |
| 2 | **バックエンド自身が返す 503 は必ず `type` を持つ**。`type` のない 503（負荷分散装置など）は「結果が不明」として**同じキーで再送**する | tower の層（負荷の制限など）が、`type` のない 503 を返してしまうと、画面が「結果が不明」と誤認して再送し、**新しいキーで再送すべき場面を取り違える** | #1 と同じ。**503 は `app.retry_exhausted`・`app.not_ready` など `type` つきだけ**にする。`type` のない 503 を返さないことを契約テストで確認 |
| 3 | **結果が不明（通信の切断）のとき、同じ冪等キーで再送すると、同じ結果を受け取る** | クライアントの切断でハンドラが途中で止まると、コマンドが**途中までしか実行されない**恐れ | **NF-R18（キャンセル安全性）と RB2**: `execute` を spawn して切断から隔離し、`Tx` の drop で部分更新を残さない。切断後の再送が保存済みの応答を返すことを DB の統合テストで検証（[テスト戦略](./test-strategy.md) の RT2）。**これが成り立てば、UI の「結果が不明」の設計は変わらない** |
| 4 | コマンドの応答は `versions` だけ。画面は応答後に**スナップショットを取得し、版に追いつくまで待つ**。SSE が切れても自分の保存は表示される | 同期投影の更新漏れで、応答の `versions` より古いスナップショットが返る | 問い合わせの REPEATABLE READ と `projection_checkpoints` の同時読み取り（[バックエンドアーキテクチャ](./architecture-backend.md)）。統合テスト「問い合わせの一貫性」 |
| 5 | SSE は版の通知だけ。再生なし。**60 秒より短い間隔の心拍**で、負荷分散装置（アイドル 60 秒）に切られない。遅い接続は切断され、再接続後にスナップショットで追いつく | axum の SSE の心拍・切断の動作は未確認（`Lagged` の接続の扱いを含む） | B1 の SSE の負荷試験と、E2E「SSE の切断」。**未確認** |
| 6 | 資格の Cookie は `HttpOnly`・`Secure`・`SameSite=Strict`。**タブごとに名前を変える**（`X-Tab-Id` ヘッダー、`bg_session_<id>`・`bg_recovery_<id>`。ADR-020。提案） | Cookie の発行・読み取りを自前で書くため、属性や名前の解決の漏れが起きうる | HTTP の統合テスト（ヘッダーのテスト）。ADR-020 は Kotlin 版でも提案中（承認前） |
| 7 | 失敗の文言は、**送った資格の種類**から選ぶ（無効な資格は、すべて同じ 403 の本文） | 認可の失敗の応答の本文が、種類によって違うと、資格の存在・期限が推測される（NF-S12） | 認可の否定テスト（無効な資格はすべて同じ応答） |
| 8 | 予期しない失敗（500）では、**相関 ID だけ**を画面に示す | panic や例外をそのまま返すと、内部の情報が漏れる | 境界で panic を `AppFailure::Persistence`（500）に写し、利用者へは相関 ID だけを返す（NF-R9、NF-R18） |
| 9 | `Retry-After` ヘッダーを `app.retry_exhausted`（503）と `app.rate_limited`（429）に付ける | 付け忘れ | 契約テスト（`Retry-After` の存在） |
| 10 | 数値（`versions`、意思決定の版）は、JavaScript で正確に扱える範囲の整数 | `u64`・`i64` の値が JSON で大きな数になると、精度を失う | 版は 1 から数える小さな整数（ストリーム 2000 件）で、実際には問題にならない。**型の範囲を契約に書く**かは未決 |

**画面の変更が必要になる場合の扱い**: 上の逸脱を契約どおりに直せず、画面側の対応が必要になったときは、**設計の矛盾として扱い**、Kotlin 版の UI 設計と合わせて更新する（Rust 版だけ画面を変えない）。

## インタラクション設計

Kotlin 版の次の節を、そのまま引き継ぎます（内容は複製しません）。

- 共通のルール（明示的なボタンで操作を始める、フォーカスと入力だけで状態を変えない）
- **保存直後の表示と投影の遅延**（応答は `versions` だけ。スナップショットを取得して追いついてから表示。同期投影のため遅延は通常ない。反映待ちの共通部品）
- **競合の種類と表示**（共同入力の競合 `session.decision_conflict`、確定済みの週 `session.week_advanced`、確定の前に入力が変わった `session.decisions_changed`、追記の競合の再試行切れ `app.retry_exhausted`）
- **エラーの `code` と表示の辞書**（正本。鍵は `code`。**Rust 版でも `code` の一覧を変えない**。Rust の列挙型の `code()` と OpenAPI の一覧が一致することを契約テストで確認し、辞書が全 `code` を網羅することも確認する。**辞書の網羅の検査が既存のフロントエンドにあるかは未確認**）
- **結果が不明なとき**（`type` のない 5xx・タイムアウト・切断は「結果が不明」として同じキーで再送。`type` つきの 503 は利用者の再操作で新しいキー）
- 主な操作の流れ、エラーと状態のフィードバック、画面の状態

## アクセシビリティ

**WCAG 2.2 AA を目標とし、Kotlin 版（と beer-game2）の内容をそのまま引き継ぎます**（キーボードだけで完了、色だけで状態を表さない、200% 拡大で横スクロールなし、操作対象の大きさ、フォーカスの管理）。検証は、コンポーネントテストと E2E の axe、手動の確認（スクリーンリーダー）です（NFR-08。担当者と時期は [Kotlin 版の未決事項](../beer-game-kotlin/ui-design.md) のとおり）。

## 設計判断

### RU1: UI 設計は複製せず、Kotlin 版を正本として参照する

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（提案）** | Rust 版の UI 設計は差分の文書にとどめ、画面・遷移・画面イメージ・辞書は Kotlin 版を正本として参照する | 食い違いが生まれない。API の契約が同じ間は変更が一度で済む。参照先を読む手間が増える |
| B | Kotlin 版の UI 設計を Rust 版に複製して持つ | 文書が自己完結する。14 枚のワイヤーフレームと辞書が二重になり、片方の更新漏れが起きる |
| C | UI 設計をプロジェクトに属さない共通の文書へ移す | 正本が 1 つになる。ドキュメント構成のガイド（プロジェクト別のカテゴリ）に反する。**構造の変更で確認が要る** |

トレードオフ: A は、Rust 版を単独で読む人が Kotlin 版に移る必要がある。**将来 UI が実装ごとに分かれる場合は、複製（B）に切り替える**（その時点の差分を ADR に記録する）。

### RU2: 契約から外れる実装の逸脱は、画面でなくバックエンドで直す

画面は API の契約にだけ依存し、実装の違いを知りません。上の影響の表の逸脱は、**バックエンドを契約に合わせて直す**（画面を実装ごとに分岐させない）。画面の変更が避けられないときは、設計の矛盾として扱います。

## beer-game-kotlin からの変更

| # | beer-game-kotlin | beer-game-rust | 理由 |
| :--- | :--- | :--- | :--- |
| 1 | 画面・遷移・画面イメージ・インタラクション・アクセシビリティを本文に持つ | **差分の文書**。本文は Kotlin 版を正本として参照（RU1） | 二重管理の回避 |
| 2 | （影響の整理なし） | Rust のバックエンドが UI の契約に与える影響の表（10 項目）を追加 | axum・tower の既定の応答の形、キャンセル安全性、SSE が、契約から外れるリスクを持つため |

**画面・遷移・インタラクション・アクセシビリティは変えません。**

## 未決事項

1. **RU1 の承認**: UI 設計を参照にとどめる方針でよいか（案 B なら複製する）。
2. **axum・tower の既定の応答**（#1・#2）: 拒否（rejection）とタイムアウト・負荷の制限の既定の形、problem+json への写像の方法（B1 で確認）。
3. **axum の SSE の心拍・切断**（#5）。
4. **辞書の網羅の検査**: 既存のフロントエンドに、辞書がすべての `code` を網羅することの検査があるか。なければ契約テストに加える。
5. **ADR-020（タブごとの Cookie 名）**: Kotlin 版でも提案中。承認後に Rust 版へ反映する。
6. **数値の型の範囲**（#10）: 契約に整数の範囲を書くか。
7. **Kotlin 版の未決事項の引き継ぎ**: 手動のアクセシビリティの確認の担当者と時期、保持の表示（暫定。M5）、自動確定の本人へのフィードバックの文言、参加者のロビーの扱い（B1 の実装は進行役だけ）、ヘルプの教材の本文の人による確認。いずれも [Kotlin 版の未決事項](../beer-game-kotlin/ui-design.md) に追従する。
8. **フロントエンドの共有方法**（フロントエンドアーキテクチャの Rust 版は未着手）: `web/` を Kotlin 版と共有するか複製するか。共有するなら、UI 設計を参照にとどめる RU1 と整合する。

## 出典

- [UI 設計（beer-game-kotlin）](../beer-game-kotlin/ui-design.md)、[beer-game2 の UI 設計](../beer-game2/ui-design.md)
- [ADR-001（Rust 版）](../../adr/beer-game-rust/001-rust-version-of-beer-game-kotlin.md)、[バックエンドアーキテクチャ](./architecture-backend.md)、[ドメインモデル](./domain-model.md)、[非機能要件](./non-functional.md)、[テスト戦略](./test-strategy.md)
- [ユーザーストーリー](../../requirements/beer-game2/user_story.md)、[システムユースケース](../../requirements/beer-game2/system_usecase.md)
