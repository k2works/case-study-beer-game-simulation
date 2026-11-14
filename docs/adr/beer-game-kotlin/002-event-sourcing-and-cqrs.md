---
type: ADR
title: "ADR-002: イベントソーシングと CQRS を採用し、2 ストリームで表す"
description: "状態をイベントの列とし、コマンド側（decide/evolve）と問い合わせ側（投影）を分ける。ストリームは game と session の 2 本で、startGame は原子的に追記する。イベントは表示名と資格を持たない。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T08:15:50Z }
---

# ADR-002: イベントソーシングと CQRS を採用し、2 ストリームで表す

状態をイベントの列として扱い、コマンドの側（`decide` / `evolve`）と問い合わせの側（投影）を分ける。ストリームは 1 ゲームにつき `game`（準備）と `session`（進行）の 2 本とし、`startGame` は 2 本へ原子的に追記する。イベントは表示名と資格を持たない。

日付: 2026-11-14

## ステータス

承認済み（2026-11-14、ユーザーの決定）

ES + CQRS の採用は、ユーザーの決定である。ストリームの単位（D1）、`startGame` の原子的な追記（D3）、イベントに入れないもの（D7）は、設計書の判断であり、レビュー（[設計書レビュー](../../review/beer-game-kotlin/design_review_20261114.md)）の指摘を反映した。

## コンテキスト

beer-game2 は、集約ごとの現在の状態を表に持ち、`version` で版つきに更新し、監査と通知のためにイベントを別に残した（[ADR-008](../beer-game2/008-auto-commit-and-event-audit.md)）。この形は、状態の表とイベントの二重管理になり、復元と監査の根拠が別々になる。

Kotlin 版は、次の事情がある。

- 状態の**履歴そのものが学習の素材**である（[バックエンド](../../design/beer-game-kotlin/architecture-backend.md) のパターンの選択）。
- 書き込み（イベントの列）と読み取り（観察・振り返り・出力）で、データの形が異なる。
- 週の確定は、4 役割がそろって一度だけ行う整合性が必要で、自動確定は最後の保存と同じ処理で判断する。
- 参加者の表示名は個人情報、資格のダイジェストは秘密である。NF-S14 は、監査・ログ・テレメトリ・出力にこれらを含めないことを求め、イベントは監査の記録を兼ねる。

## 決定

- **状態はイベントの列**とする。集約は `decide(state, command): Either<DomainError, List<Event>>` と `evolve(state, event): State` の 2 つの純粋関数で表す。状態の復元は、イベントの再生（`fold(evolve)`）である。
- **コマンド側と問い合わせ側を分ける（CQRS）。** コマンド側は `events` へ追記する薄い処理で、ルールは `decide` が持つ。問い合わせ側は、投影の表を SQL で読む（更新の方式は [ADR-003](./003-synchronous-projections.md)）。
- **ストリームは 1 ゲームにつき `game` と `session` の 2 本**とする（ドメインモデル D1）。`StartGame` だけが 2 本をまたぐ例外で、**同一トランザクションで原子的に追記**する（D3）。両ストリームの期待する版を渡して競合を検出する。
- **自動確定は、`decide` が複数のイベント**（`DecisionSaved`、`WeekCommitted`、必要なら `SessionEnded`）**を返す**ことで、1 回の追記にする（D6）。
- **`SessionStarted` が設定と役割の割り当ての写しを運ぶ**（D4）。`session` の `decide` は `game` ストリームを読まない。
- **`WeekCommitted` は結果と次週の状態を事実として含む**（D5）。`evolve` は採用するだけで、`simulateWeek` を呼び直さない。
- **ゲームの終了は `game` ストリームに書かず、投影で導出する**（D2）。
- **イベントは、表示名と資格のダイジェストを持たない**（D7）。識別子と有効期限だけを置き、表示名は `display_profiles`、資格のダイジェストは `credentials` の周辺ストアに、同じトランザクションで書く。

並行制御と冪等性は [ADR-004](./004-idempotency-after-authorization.md)、[ADR-005](./005-optimistic-concurrency-and-advisory-lock.md)、スキーマの進化は [ADR-006](./006-event-schema-evolution.md) で定める。

### 代替案

- **beer-game2 の「版つきの更新 + 監査用イベント」を維持する**: 実装は変わらず、リスクが小さい。ただし、状態の表とイベントの二重管理が残り、復元はバックアップに頼る。ユーザーが ES + CQRS を求めている。
- **完全な ES にせず、状態の表 + イベントの追記にする**: 状態の表を正本にしてイベントを追記する形。実装は単純になる。ただし、どちらが正かが曖昧になり、「イベントの再生で状態を復元できる」（FR-12）という ES の利点を失う。
- ストリームの単位（設計書の案の表）: 1 ゲーム 1 本は、進行中の追記が資格の失効や復帰と同じ版を取り合い、競合が増える。役割ごとのストリームは、週確定が複数のストリームにまたがる。
- 終了の書き方（D2）: `GameEnded` を購読者が追記する案は結果整合になり、最終週の確定で 2 本へ同時に追記する案は `game` の版を取り合う。
- 開始（D3）: `GameStarted` の購読者が `SessionStarted` を追記する案は、開始済みだが進行できない状態が生まれる。
- 再計算（D5）: イベントに入力だけを持たせ `evolve` が再計算する案は、規則の変更が過去のゲームを書き換える。
- 個人情報（D7）: 暗号化してイベントに含める案（crypto-shredding）は鍵管理が増え、平文の案は NF-S14 に反する。

## 影響

### ポジティブ

- 状態と監査の根拠が `events` の 1 か所になる。復元は、再生と同じ経路である。
- ルールが純粋関数 `decide` に集まり、Given（過去のイベント）/ When（コマンド）/ Then（新しいイベント）がそのままテストになる。
- 後で計算規則を直しても、過去のゲームの再生結果が変わらない（D5）。
- イベントを公開・出力しても、個人情報と秘密が漏れない。

### ネガティブ

- `StartGame` が 2 ストリームをまたぐ例外になる。
- `WeekCommitted` が大きい（1 週で 4 役割分の結果と待ち行列を含む）。1 ゲームの総量は小さいと見積もっている（数 MB 以下）。
- 再生では表示名が復元されない（業務の状態には不要）。
- 「ゲームが終了したか」を `game` ストリームだけから知れない。この判定は投影が担う。終了後の資格の扱い（NF-S4）が `Started` の規則で足りるかは**未決事項**である。
- 開始後に共同担当の参加者を追加する場合は、写しを更新するイベントが要る（**未決事項**。当面は準備中だけ）。
- 設計の複雑さは、beer-game2 より増える。

## コンプライアンス

- **振る舞いの先行定義**: `decide` と `evolve` を、Given（過去のイベント）/ When / Then の Kotest で書く。B1（最小の縦）から、B5〜B8（進行の継続、共同担当、カスタム条件、自動確定）で拡張する（[テスト戦略](../../design/beer-game-kotlin/test-strategy.md)）。
- **永続化往復の同値性**: 任意の有効なコマンド列で、実行中の状態が DB から読んだイベントの再生と一致する（性質 (a)、NF-R16）。計算と事実の一致（性質 (b)、D5）。B1 の縦の最小から、毎回の CI で実行する。
- **`evolve` が `simulateWeek` を呼ばないこと（M18）**: シミュレーションが出すはずの値と意図的に違う `nextStates` の `WeekCommitted` を Given にして、状態がその値を採用することで確かめる。純粋性（時計・乱数を読まない）は detekt の `ForbiddenMethodCall` で守る（[ADR-011](./011-strict-static-analysis.md)、B2）。
- **`StartGame` の原子性**: どちらかの追記が失敗したら両方が残らないことを、DB の統合テストと障害の注入で確かめる（B1）。
- **自動確定が一度だけ**: AC2.4.1〜2.4.4 を、2 プロセスの並行テストで確かめる（B8）。
- **個人情報の不在**: イベントのペイロードに表示名・資格が含まれないことを、イベント型ごとの検査で確かめる（B1 から、B5 の資格の拡張で再確認）。
- **ES の安全性の穴（レビュー H4・H5・H7）の解消**: [ADR-004](./004-idempotency-after-authorization.md)、[ADR-005](./005-optimistic-concurrency-and-advisory-lock.md) のコンプライアンスで確かめる。

## 備考

- 著者: claude-code
- 関連 ADR: [ADR-001](./001-kotlin-version-of-beer-game2.md)、[ADR-003](./003-synchronous-projections.md)、[ADR-004](./004-idempotency-after-authorization.md)、[ADR-005](./005-optimistic-concurrency-and-advisory-lock.md)、[ADR-006](./006-event-schema-evolution.md)、[ADR-010](./010-retention-deletion-with-append-only.md)。beer-game2 の [ADR-004](../beer-game2/004-separate-game-and-session-aggregates.md)、[ADR-008](../beer-game2/008-auto-commit-and-event-audit.md)
- 参照: [ドメインモデル](../../design/beer-game-kotlin/domain-model.md)（D1〜D7）、[データモデル](../../design/beer-game-kotlin/data-model.md)、[バックエンド](../../design/beer-game-kotlin/architecture-backend.md)、[設計書レビュー](../../review/beer-game-kotlin/design_review_20261114.md)
