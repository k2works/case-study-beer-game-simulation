---
type: Review
title: "設計書レビュー - beer-game-rust（2026-11-21）"
description: "beer-game-rust の設計書 10 本と ADR-001 を、プロダクトマネージャー・アーキテクト・インタラクションデザイナー・テスター・ユーザー代表の 5 視点で並列にレビューした統合結果。重要度「高」9 件、「中」20 件、「低」12 件。対応方針は案で、人が確定する。"
tags: [review]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-21T01:07:57Z }
---

# 設計書レビュー - beer-game-rust（2026-11-21）

## レビュー対象

- `docs/design/beer-game-rust/` の設計書 10 本（アーキテクチャ 3、データモデル、ドメインモデル、UI 設計、テスト戦略、非機能要件、運用要件、技術スタック）と、`index.md` の承認記録、[ADR-001](../../adr/beer-game-rust/001-rust-version-of-beer-game-kotlin.md)。
- 状況は `draft`。実装コードは存在しない。承認済みの設計判断は 24 件（2026-11-19）。
- 5 視点とも**読み取り専用**で実施した。精読の範囲は視点ごとに異なる（PM は operation・infrastructure・ui-design を部分的に確認、アーキテクトとテスターは全文書）。エージェントの出力は**モデルの出力**であり、ユーザーの承認ではない。

## 事実確認の結果（統合時に自分で確認した主な指摘）

| 指摘 | 結果 |
| :--- | :--- |
| NOLOGIN ロールに設定した `idle_in_transaction_session_timeout` が、メンバーのログインユーザーに効かない（AR、TS） | **確認済み**。使い捨ての `postgres:18.6` で再現した。NOLOGIN の `beergame_writer` に `2s` を設定してもメンバーで `SHOW` すると `0`（`SET ROLE` した後も `0`）。ログインユーザー自身に設定すると `2s`。**運用要件の「実測」は、ログインロールに設定したときの結果で、設計文に書いた設定先（`beergame_writer`）が誤り** |
| NF-P16 のコールドスタート後の目標が、Kotlin 版（2 秒）より厳しい 1 秒になっている（PM、TS、AR） | **確認済み**。Rust 版の値は「NF-P1 と同じ 1 秒以下」。RN1（実測前に厳しくも緩くもしない）に反する |
| ADR-001 の「承認済みは 012・015〜019」が不正確（PM） | **確認済み**。Kotlin 版の索引で 001・002 も「承認済み」 |
| 古い「未着手」「84 件」の記述が残っている（UR、UX、AR、PM、TS） | **確認済み**。operation.md、ui-design.md、test-strategy.md、architecture-backend.md、ADR-001 に残る（下の M1） |
| ADR-001 の「版は別の ADR で固定する」の ADR がない（PM、AR） | **確認済み**。`docs/adr/beer-game-rust/` には 001 だけ。実際は tech-stack.md の R7 が担っている |
| NF-S22 が承認記録（index.md）に載っていない（PM） | **確認済み**。承認時の選択肢の説明には含まれていたが、記録は NF-R18 だけ |
| 既存の `web/` は SSE を使わず、3 秒間隔のポーリング（UX） | **確認済み**（調査済みの事実。`PlayPage.tsx` の `PLAY_POLL_MS`） |

## 総合評価

**構造は健全**です。正本を流用し差分だけを書く方針（RU1・RF1）、NF の 86 件の ID の機械的な突き合わせ（欠落なし）、確認済みと未確認の書き分け、PostgreSQL 18.6 での実測の範囲の明記は、5 視点とも評価しました。Kotlin 版の初回レビューで指摘された 4 点（認可を冪等照合の前に置く、再試行の制約名、`If-Match` の意味、トランザクションの意味論）が解消されていることも、アーキテクトが確認しています。

一方で、実装に入る前に直すべき問題が 3 系統あります。

1. **承認済みの RB2（キャンセル安全性）のリスクの置き場所がずれています。** 部分更新は PostgreSQL が防ぎます。本当のリスクは、**ロック・接続が解放されるまでの遅れ、spawn したタスクの寿命、タイムアウトと COMMIT の結果が不明になること**です。しかも、その安全網として書いた `idle_in_transaction_session_timeout` の設定先が誤っていました（H1）。承認時に見えていなかった欠陥のため、判断の見直しとして再提示します。
2. **利用者に見える振る舞いの穴**が 3 つあります。タイムアウト応答が「結果が不明」の規則と衝突し二重操作を招く、元の処理の実行中に届く再送の扱いが未定義、現行の画面が使うポーリングを前提にした記述になっていない（H4・H5）。
3. **文書間の食い違いと、承認済みの方針に反する数値（NF-P16）**です。「未着手」「未決」の古い記述が、解消済みの判断の後も残っています（H6、M1）。

## 改善提案（重要度順）

指摘元の略号: PM=プロダクトマネージャー、AR=アーキテクト、UX=インタラクションデザイナー、TS=テスター、UR=ユーザー代表。複数の視点が同じ点を挙げたものは 1 件にまとめた。

### 高

| # | 提案 | 指摘元 | 理由 |
| :--- | :--- | :--- | :--- |
| H1 | **`idle_in_transaction_session_timeout` の設定先を、NOLOGIN ロールからログインユーザー（または接続文字列の `options`、接続後の `SET`）に直す。** 統合テストに「アプリの接続で `SHOW` が期待値になる」を加える（operation.md 障害パターン 17、architecture-infrastructure.md のロール表、data-model.md） | AR, TS | 確認済み。NOLOGIN ロールの設定はメンバーに継承されない。安全網が効かない構成を「実測済み」と書いていた |
| H2 | **RB2 のリスクの置き方を見直す。** 通常の失敗の経路では `tx.rollback().await` を明示し、drop は panic・ランタイム終了時の保険にする。NF-R18・RT2 の検証は「部分更新が残らない」（PostgreSQL が保証する）でなく、**ロックと接続の解放時間、プールに返った接続がトランザクション外であること**に変える。RT2 の「`execute` の途中で future を drop する」は、spawn する本番の構成では起きないため見直す（architecture-backend.md「キャンセル安全性」、test-strategy.md RT2、non-functional.md NF-R18） | AR, TS | sqlx の drop の ROLLBACK は遅延する見込み（未確認）。drop に頼ると、ロックを握ったまま接続が残り、再構築の排他ロックの待ちとプールの枯渇が静かに進む |
| H3 | **spawn したタスクの寿命の管理を設計に足す。** 追跡の仕組み（導入には承認が要る）、SSE を終了時に止める手順（graceful の待ちが `stopTimeout` に達し SIGKILL になると「終了コード 0」を満たせない）、切り離したタスクの同時実行数の上限、プール取得のタイムアウトの `AppFailure` への写像を決める（architecture-backend.md 未決 4、architecture-infrastructure.md RI4） | AR | `JoinHandle` の drop でタスクは切り離される。axum の graceful shutdown は接続だけを待ち、切り離されたタスクの完了を待たない（見込み。未確認） |
| H4 | **タイムアウトの応答と「結果が不明」の矛盾を解消する。** tower のタイムアウトは `type` を付けない応答（例: 504）にして「結果が不明」と扱う。**元の処理が実行中のときに同じキーの再送が届いた場合の応答**（待つ／409／競合）を定義し、表 #3 と RT2 に加える（ui-design.md 影響表 #1〜#3） | UX, AR | 画面は `type` つきの応答を「未実行」と扱い、新しいキーで再操作を促す（`client.ts`）。タイムアウト後も処理が COMMIT まで進みうるため、ゲーム作成などが二重になる（見込み）。409 になると、新しいキーでの再操作を促してしまう |
| H5 | **ui-design.md の影響表 #4・#5 を、現行の画面の実態（SSE なし、3 秒のポーリング）に合わせる。** ポーリングの失敗が黙って無視される点、tower のレート制限をポーリングに適用しない点、NF-P2（p95 2 秒）を 3 秒間隔で満たせない見込みを明記し、SSE・間隔・NF-P2 の扱いを決める（ui-design.md、architecture-frontend.md、non-functional.md NF-P2・NF-C1・NF-P17 の想定） | UX, PM | 確認済み（`PLAY_POLL_MS = 3000`）。反映の遅れは最大で約 3 秒に GET の時間を足したもの。負荷の想定も SSE 75 本でなく、ポーリングの GET（見込みで毎秒 50 件程度） |
| H6 | **NF-P16 の「コールドスタート後 60 秒間」を、Kotlin 版の 2 秒に戻す**（または RN1 の例外として承認を取り直す）（non-functional.md NF-P16、変更表） | PM, TS, AR | 確認済み。承認済みの RN1 に反する。私の誤り |
| H7 | **共有する `features/` と「Undefined・Pending があれば失敗」を両立させる。** Rust 側で実行するシナリオの許可リスト（タグまたは ID）を持ち、共有ファイルに `@wip` を書き込まない。B1 の受入条件に入れる（test-strategy.md 107・319 行、architecture-frontend.md RF1） | PM, TS | 共有する `features/` には 36 本の `.feature` がある。B1 の時点では Rust の `@api` がほぼ全部 Undefined になり、CI が常に赤になる |
| H8 | **Rust 版の価値を測る指標と、リリース計画の見取り図を決める。B1 の受入条件を絞り、観察可能な形で書く。** 指標の案: 共有 `features/` のうち Rust のバックエンドで通る割合、Must のストーリー 11 本のパリティ。B1 は、スケルトンに必要なもの（`Tx` の ROLLBACK、制約名の取得、serde の書式）に絞り、未確認の前提ごとに「成り立たなければ何を見直すか」を書く。ツールの前提は合否の基準にする（cucumber-rs の skipped の扱い、proptest の操作列、cargo-llvm-cov の nightly、testcontainers のタグ、clippy の lint の衝突）（test-strategy.md、docs/development/beer-game-rust/） | PM, TS | 設計文書は「B1 で確かめる」に約 70 か所依存し、B1 が太りすぎる。合否の基準がない |
| H9 | **運用の案内を、進行役・運営者向けにも書く。** パターン 15・17 に、運営者を通じた進行役への依頼文言と影響の説明（再接続は自動、入力済みの発注は保存されている）を加える（Kotlin 版のパターン 13・14 に倣う）。進行役向けの「研修中にシステムが止まったら」の案内（紙の控え、復旧後の代理入力、振り返りへの切り替え）を、手順書の一覧に加える（operation.md） | UR, UX | 手順書がすべて運用担当向け。パターン 17 は研修の現場への影響が最も大きい。RTO 15 分は 90 分前後の研修で大きな割合を占める。この間、画面は「問題が発生しました」を出し、再操作が負荷を増やす |

### 中

| # | 提案 | 指摘元 | 理由 |
| :--- | :--- | :--- | :--- |
| M1 | **解消済みの判断が「未着手」「未決」のまま残る記述を直す。** 対象: operation.md 32・46・339 行（インフラ設計は未着手）、ui-design.md 164 行（フロントエンドは未着手）、test-strategy.md 254 行（NFR 84 件・Rust 版は未着手）、architecture-backend.md 383 行（テスト戦略は未着手）と未決 8（契約の共有方法）、tech-stack.md の未決 6 と実行イメージの「未決」、architecture-infrastructure.md の IaC の行・変更表 #12・未決 3（RI5）、operation.md の未決 7（SIGTERM。RI4 は承認済みで、実現の確認が B1 に残るだけ）、architecture-backend.md 347 行（ローカル DB）、同 260 行（api が持つプールの種類。削除・所有者は retention・migrate） | UR, UX, AR, PM, TS | 確認済みのものを含む。読み手が承認済みの判断を未決と誤解する |
| M2 | **ADR-001 の記述を直す。** 承認済みは 001・002・012・015〜019。「版は別の ADR で固定する」を tech-stack.md の R7 に合わせる（または別の ADR を起票する） | PM, AR | 確認済み。事実の誤りと、実行されていない約束 |
| M3 | **NF-S22 の承認を記録に反映する。** 承認時の選択肢の説明に含まれていたが、記録は NF-R18 だけ。承認の範囲を確認し、index.md を直す | PM | 「承認は明示された範囲だけを記録する」規律 |
| M4 | **`lock_timeout` の初期値を B1 の受入条件に入れる。** 未設定だと、再構築の間、コマンドがロックを無期限に待ち、タスクと接続が積み上がる。`idle in transaction` の安全網は `active` の待ちを切らない（architecture-backend.md、data-model.md 未決 5） | AR | 55P03 を `RetryExhausted` に写す設計が、`lock_timeout` の設定を前提にしている |
| M5 | **ヘルスチェックの対象と置き場所を見直す。** コンテナの生存は `/health`、負荷分散は `/ready` に分ける（`/ready` は DB に依存し、DB 障害で全タスクが unhealthy になり ECS が入れ替えを繰り返す）。ECS はタスク定義の `healthCheck` を使う見込み（未確認）。`healthcheck` サブコマンドは `AppConfig::load` を通さない軽い経路にする（architecture-infrastructure.md RI3） | AR | 障害を広げる構成の回避 |
| M6 | **`panic = "abort"` は、未決でなく制約として固定する（unwind を前提にする）。** `JoinError` への写像、NF-R18 の panic の要件、RT2 は unwind を前提にしている。release の panic の方針を採らない場合でも、コンテナのスモークテストで確認する（architecture-infrastructure.md、architecture-backend.md） | AR, TS | テストのビルドは常に unwind で、本番の振る舞いを保護しない |
| M7 | **RD2 の `Ignored` の扱いと実行層のスケッチの食い違いを直す。** `run_once` の `evolve: Fn(S,&E)->S` と `Evolution<S>`、`decide_session` の `.into_state()` で `Ignored` を黙って捨てている点。**コマンドの経路では `Ignored` を失敗（fail closed）にする**。`StreamRead.version` の数え方（件数か `MAX(stream_version)`）を明記する（domain-model.md、architecture-backend.md） | AR | 保存済みの事実を無視した状態で `decide` すると不変条件が崩れる |
| M8 | **エラー `code` の契約の写像を、Rust 版の文書か `openapi.yaml` に明記する。** Kotlin 版は `ProblemMapping.kt`（実装ファイル）が正本（`session.forbidden`・`game.forbidden` は `app.unauthorized` に写る、409 の拡張メンバー）。「Kotlin 版の文書を正本とする」だけでは足りない（domain-model.md RD4） | AR | 写像が抜けると契約が変わる |
| M9 | **`session_overview.week` が最終週 + 1 になる問題の案を直す。** 投影の型 `&Event -> Vec<RowChange>` は状態を持たず、「`SessionStarted` の最終週を覚える」ことができない。`WeekCommitted` に次の週・終了の事実を持たせる、または式の更新を `RowChange` に加えるなどを比べる（data-model.md 未決 4） | AR | 提案が投影の型と合わない |
| M10 | **RT2 のテストに差し込み口を設計する。** 「追記の後・COMMIT の前で止める」を決定論的に再現できるポートのデコレーター（barrier・フック）を、`EventStore`・`Tx` に明記する（architecture-backend.md、test-strategy.md） | TS | 差し込み口がないと、RT2 が書けない |
| M11 | **DB の統合テストの分離と「0 件なら失敗」の仕組みを決める。** 「実行全体でコンテナを 1 つ共有」と「空の DB から始める」は、全ゲームの再構築・`information_schema` の走査・マイグレーションのテストで干渉する。テンプレート DB からテストごとに DB を作る案など。`cargo test` には飛ばした件数を数える仕組みがなく、`#[ignore]` と環境変数などで 0 件を検出する。`#[tokio::test]` ごとにランタイムが別のため、static の `PgPool` の共有は不具合のリスク（test-strategy.md） | TS | 干渉と、暗黙のスキップの検出 |
| M12 | **非機能要件の測定可能性を直す。** NF-P17（「RSS 70% 以下」と「目標値は実測で決める」が同じ行）、NF-R18 の待ちの上限の数値と `stopTimeout` の値、NF-P16 の「大きく下回る場合」の基準、NF-O5 の測定方法（目視だけ）、NF-S22 の可視化手段。合否の式と未決の値を ID で分けて書く（non-functional.md） | TS | 合否が読めない |
| M13 | **S02 の「誤りを一度に示す」の根拠を補う。** axum の `Json` と serde は最初の型の誤りで解析を止める。DTO の段階で誤りが集まる保証はない（見込み）。`errors[].field`（例: `quantity`）のフィールド名の一致も契約に含める（ui-design.md 94 行） | UX | 根拠にしている `collect` はドメインの段階 |
| M14 | **辞書の網羅の検査は既存である（確認済み）ので、「未確認」を直す。** `problems.ts` は `Record<ErrorCode, string \| null>` で、`null` の `code`（`request.*` など）は一般の文言になる。Kotlin 版 ui-design.md の 376 行・667 行は実装（3 秒のポーリング）と合っていない（ui-design.md 122 行・未決 4） | UX | 参照先が古いと差分の文書も誤る |
| M15 | **正本への追跡可能性を高める。** ファイル単位の参照を節単位のアンカーにし、基準にした版・日付を残す（ui-design.md 20〜23・128 行） | UX | Kotlin 版の更新時に Rust 版の表を見直すきっかけがない |
| M16 | **Kotlin 版の実装の注記の扱いを、1 つの基準に揃える。** 「経緯は捨て、**確定した業務ルールは引き継ぐ**」（例: 保存回数の上限 9 回は共同担当で共有、`ParticipantReplaced`・`replaced_at`、`Abandoned`）。文書ごとに引き継がない範囲が B1〜B9／B12／B15 とばらついている | PM | 実装中に確定した業務ルールの抜け |
| M17 | **停止中の代理入力の形を、ドメインモデルのスケッチに明記する。** 「進行中または停止中で受け付け、停止中は自動確定しない」を 1 行で示す（domain-model.md 274・300 行） | UR | Kotlin 版のレビューで、ここが誤っていた前例 |
| M18 | **パターン 17 の自動切断で、利用者に何が見えるかを書く。** 切断されたコマンドが、型つきの 503 か、結果が不明の応答か（ui-design.md の影響表に 1 行） | UR, UX | 再操作の可否が変わる |
| M19 | **`/ready` と `/api/v1/ready` の表記を 1 つにそろえる**（non-functional・operation・architecture-infrastructure） | TS | 契約を共有するなら統一する |
| M20 | **「確認済み」の範囲の但し書きを入れる。** 非同期のポート差し替えのテストは、自前の `block_on`・標準ライブラリだけの確認で、tokio と実際のクレートの組み合わせは未確認（test-strategy.md 20・72 行） | TS | 範囲を広げて読まれる |

### 低

| # | 提案 | 指摘元 | 理由 |
| :--- | :--- | :--- | :--- |
| L1 | `AppFailure` の写像の表で、ドメインの分類と `AppFailure` の列挙子が混ざっている。`Invalid`（422）、`IdempotencyKeyReused`（409）、内部の `ConcurrencyConflict` の扱いを表に加える | AR | 表に抜けがある |
| L2 | `AppFailure::Domain(DomainError)`・`start_game -> DomainError`・集約ごとの `GameError`/`SessionError`・`Projection` の `DomainEvent` の統合型が未定義。統合の形を決める | AR | 型の食い違い |
| L3 | `verify-projections` は書き込みロールで動く設計。投影を変えないので、`events` を読める読み取り専用のロールに分ける | AR | 最小権限 |
| L4 | non-functional.md の NF-S5 の要約（「認証はアダプター」）が RB3（「`execute` の中」）と文言で食い違う（正本の Kotlin 版も同じ文言） | PM | 表現の問題 |
| L5 | domain-model.md 365 行の「serde の内部タグ付き列挙型」を「adapter の DTO で」と明記する | PM | BD5 との混同 |
| L6 | NF-S16 の要約から「バックアップに最大 7 日残ることの画面表示」が抜けている | PM | 要約だけを読む人が見落とす |
| L7 | RT1 の命名: 複数の AC を保証するテストの書き方、`us2_4_` が AC の ID と冗長。抽出のツールを作る前に決める | TS | 規則が曖昧 |
| L8 | COMMIT の結果が不明な 500（フェイルオーバー中など）にも `type` が付き、画面は再送しない。ゲーム作成は `If-Match` で守られない。Kotlin 版と共通の課題として未決事項に残す | UX | 二重作成の余地 |
| L9 | tech-stack.md の R4（clippy が主）と test-strategy.md（依存の制限が第一の守り）で、主と補いが逆 | TS | 表現の食い違い |
| L10 | data-model.md の「SQLSTATE 42501 相当」は、実際に観測した SQLSTATE かが読めない | TS | 事実の書き分け |
| L11 | ADR-001 は本文が「承認済み」、フロントマターは `status: draft`。OKF の status と ADR のステータスの関係を index.md に一言足す | AR | 誤解の予防 |
| L12 | operation.md の「NF-O12（新）」は、non-functional.md では「変更」。NF-S22 の新設が index.md の RN の行にない（M3 と関連） | TS | 表記の食い違い |

## 矛盾事項

| # | 視点 A | 視点 B | 論点 | 推奨判断 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | AR・TS: 部分更新は PostgreSQL が防ぐので、RB2 は明示 ROLLBACK を主にする | 承認済みの RB2: `Tx` の drop で ROLLBACK し、`execute` を spawn する | drop に頼る設計は、sqlx の遅延する ROLLBACK（未確認）と衝突する | **見直しとして再提示する**（承認時に見えていなかった欠陥）。spawn は維持し、明示 ROLLBACK を主にして drop を保険とする |
| 2 | UX: タイムアウトは `type` のない 504 にして「結果が不明」と扱う | 文書: 「バックエンド自身が返す 503 は必ず `type` を持つ」 | 503 と 504 は別の応答。同じ規則に見えるが、役割が違う | **整合する**: 503（`app.retry_exhausted`・`app.not_ready` など）は `type` つき、タイムアウト（504）は `type` なし。契約テストで固定する |
| 3 | PM: SSE はフロントエンドが使い始めるまで作らない（YAGNI） | NF-P2（反映 p95 2 秒）・NF-P4 は SSE を前提にし、UX: ポーリング 3 秒では NF-P2 を満たせない見込み | 現行の画面はポーリング。NF-P2 をどう満たすか | **人の判断**（SSE を作る／ポーリング間隔を詰める／NF-P2 の測定を B1 で行い判断する）。実測前に決めない（RN1 と同じ方針） |
| 4 | UR: RPO 0 の約束を Multi-AZ のフェイルオーバーに限り、DB の全面復元は「その研修はやり直し、振り返りは確定済みの週まで」と運営者に説明できればよい | 文書: RPO 0・RTO 15 分を SLO として扱う（PITR では成り立たない。未決） | 約束の範囲 | **人の判断**（運営者との合意）。案として UR の整理を提示する |

## 懸念事項（実装前に確認する）

- **ロックの解放の遅れは、検知の手段が弱い。** RB2 の前提が崩れても、データは壊れないが、ロックが残ると再構築の待ちとプールの枯渇が静かに進む。検知が障害パターン 17 だけに頼っており、その設定先も誤っていた（H1）。
- **COMMIT の結果が不明な場合の回復は、同じ `Idempotency-Key` での再送だけ。** tower の層が返す応答の `type` の有無を、契約テストで固定する（H4）。
- **確認していない前提が B1 に集中している。** sqlx（drop、制約名、LISTEN、マイグレーション）、axum の SSE、cucumber-rs の日本語、clippy の lint（H8）。
- **共有による結合。** `features/`・`contracts/`・`web/` を Kotlin 版のディレクトリのまま共有するため、Kotlin 側の変更がそのまま Rust 版の CI に影響する。変更を通知する運用（誰がいつ追従するか）が決まっていない（PM）。
- **正本が 3 系列に分かれている。** Kotlin 版の多くの ADR は「提案中」で、一部の正本は実装コード（`ProblemMapping.kt`）にある。「Kotlin 版を正本とする」は、文書だけでは閉じない（AR、PM）。
- **保存回数の上限 9 回**は、ドメインモデルでは不変条件として扱われ、非機能要件では運営者と合意する未決事項。利用者に見える制約のため、合意を優先する（PM）。
- **「結果を確認しています…」の表示と、確認中の入力欄の読み取り専用は未実装**（UX）。RB2 は切断後も処理が続く場面を増やすため、Rust 版で危険が大きくなる見込み。

## スコープ外の発見

- `apps/beer-game-kotlin/**/out/` の生成物が、変更あり・未追跡として大量に出ている。`.gitignore` の対象漏れの可能性（PM。確認していない）。
- Kotlin 版にも、進行役向けの障害時の案内が無いようにみえる（UR。grep の範囲）。Rust 版で加えるなら、Kotlin 版のヘルプ（S11）にも反映する。
- 手動の資格の失効（`RevokeCredential`）が `game` ストリームだけに追記される場合、READ COMMITTED の下では、`session` への同時の保存が失効前の認証で通る窓がある（AR。Kotlin 版と共通。実際の追記先は確認していない）。
- `Secure` 属性の Cookie を `http://localhost` で WebKit が受け入れるか（NF-U4 のブラウザ行列。確認していない）（UX）。
- ユーザー代表のエージェントが、自身のエージェントメモリ（`.claude/agent-memory/xp-user-representative/beer-game-business-rules.md`）に 1 行を追記した。設計文書は変更していない。

## 対応方針（案。人が確定する）

AI が先回りして確定しない。重要度「高」の各項目について、次の案を出す。

| # | 案 | 備考 |
| :--- | :--- | :--- |
| H1 | **修正する** | 設定先を直し、検証を加える。事実として確認済み |
| H2 | **修正する（RB2 の見直しとして、承認を取り直す）** | 承認済みの判断の変更を含む |
| H3 | **修正する（設計に追記）。タスクの追跡の導入は B1 の依存関係の承認で扱う** | 新規依存は B1 で承認 |
| H4 | **修正する** | 契約の定義の追加 |
| H5 | **修正する（記述の実態合わせ）。NF-P2 の扱いは人の判断（矛盾事項 3）** | |
| H6 | **修正する（2 秒に戻す）** | 私の誤り。承認の取り直しは不要 |
| H7 | **修正する（許可リストの方針を決める）。具体の仕組みは B1 の計画で** | |
| H8 | **B1 の計画（`planning-releases`）で扱う。設計文書には、受入条件の書き方の方針を追記する** | |
| H9 | **修正する（運用要件に追記）** | |

中・低は、一覧のとおり修正する案。M3（NF-S22 の承認の範囲）、M6（panic の方針）、M9（投影の案の選択）は、人の判断が要る。

## 対応結果（2026-11-21。ユーザーの決定に基づく）

ユーザーは、次のとおり決定した（`AskUserQuestion` による）。

- **H2（RB2 の見直し）**: 承認した。
- **H1・H3・H4・H5・H6・H7・H9**: 案どおり修正する。**H8** は B1 の計画（`planning-releases`）で扱う。
- **矛盾 3（NF-P2）**: **B1 で測って決める**。
- **中・低 32 件**: 案どおり修正する（M3: NF-S22 を承認済みとして記録、M6: `panic = "unwind"` を制約として固定、M9: 案の選択は B1）。
- **矛盾 4（RPO・RTO の約束の範囲）**: まだ決めていない（人の判断が残る）。

反映した結果は次のとおり。**「修正済み」は文書への反映を指し、実装・実測の確認ではない。**

| # | 結果 | 反映先 |
| :--- | :--- | :--- |
| H1 | 修正済み。設定先をログインユーザーに訂正し、`SHOW` の検証をテスト戦略に追加 | operation.md、architecture-infrastructure.md、data-model.md、test-strategy.md |
| H2 | 修正済み。`rollback` を明示する `execute` のスケッチを、型検査してテストした（4 件）。RB2・NF-R18・RT2 を見直し | architecture-backend.md、test-strategy.md、non-functional.md、index.md |
| H3 | 設計に追記。**実現と追跡の依存の承認は B1** | architecture-backend.md、architecture-infrastructure.md |
| H4 | 修正済み。タイムアウトは `type` なしの 504、実行中の再送は完了を待つ。**実現は B1** | ui-design.md（#11）、architecture-backend.md、test-strategy.md |
| H5 | 修正済み（記述を実態に合わせた）。**NF-P2 の方式は B1 の実測で決める** | ui-design.md（#12）、non-functional.md、architecture-frontend.md |
| H6 | 修正済み（NF-P16 を 2 秒に戻した） | non-functional.md、operation.md |
| H7 | 方針を追記（許可リスト）。**具体の仕組みは B1** | test-strategy.md |
| H8 | 設計文書には、B1 の受入条件の書き方と指標の案を追記。**リリース計画は `planning-releases` で** | test-strategy.md |
| H9 | 修正済み（案の文言と、進行役向けの案内の手順書を追加）。**文言は案で、運営者との合意は未** | operation.md |
| M1〜M20 | 修正済み。M9・M10 は案の整理と設計の追記で、選択・実現は B1。M12 は NF-P16・NF-P17・NF-R18・NF-O5・NF-S22 を修正（NF-R18 の待ちの上限の数値は B1） | 各文書 |
| L1・L5・L6・L9〜L12 | 修正済み | 各文書 |
| L2 | 未決事項へ（統合のエラー型は B1 の最初のスライドで決める） | architecture-backend.md |
| L3 | **部分的**。全体構成の図に注記した。読み取りロールに `events` の SELECT を与えるかは B1 | architecture-infrastructure.md |
| L4 | 修正済み（NF-S5 の要約を RB3 に合わせた） | non-functional.md |
| L7 | 命名の規則を追記。**承認は未**（未決事項 17） | test-strategy.md |
| L8 | UI の影響表 #11 に記載し、Kotlin 版と共通の課題として残す | ui-design.md |

**検証**: `gulp okf:check`・`docs_structure.py check --check` は ERROR 0、リンク・PlantUML の検査は問題なし。**`verified` は付けていない**（ユーザーが確認した範囲にだけ付ける）。

**残っている人の判断**: 矛盾 4（RPO・RTO の約束の範囲）、RT1 の命名の規則（L7）、H9 の依頼文言の運営者との合意。

## エージェント別フィードバックの件数

| 視点 | 高 | 中 | 低 |
| :--- | ---: | ---: | ---: |
| xp-product-manager | 3 | 4 | 3 |
| xp-architect | 3 | 8 | 3 |
| xp-interaction-designer | 3 | 4 | 1 |
| xp-tester | 4 | 5 | 2 |
| xp-user-representative | 2 | 3 | 0 |

統合で、重複する指摘を 1 件にまとめた（高 9、中 20、低 12）。件数は各視点の元の指摘の数。

## 出典

- 設計書: [index](../../design/beer-game-rust/index.md)、[技術スタック](../../design/beer-game-rust/tech-stack.md)、[ドメインモデル](../../design/beer-game-rust/domain-model.md)、[バックエンド](../../design/beer-game-rust/architecture-backend.md)、[データモデル](../../design/beer-game-rust/data-model.md)、[テスト戦略](../../design/beer-game-rust/test-strategy.md)、[非機能要件](../../design/beer-game-rust/non-functional.md)、[インフラ](../../design/beer-game-rust/architecture-infrastructure.md)、[運用要件](../../design/beer-game-rust/operation.md)、[UI 設計](../../design/beer-game-rust/ui-design.md)、[フロントエンド](../../design/beer-game-rust/architecture-frontend.md)、[ADR-001](../../adr/beer-game-rust/001-rust-version-of-beer-game-kotlin.md)
- 形式の手本: [設計書レビュー（beer-game-kotlin、2026-11-14）](../beer-game-kotlin/design_review_20261114.md)
- 事実確認: 使い捨ての `postgres:18.6`（NOLOGIN ロールの設定の継承。2026-11-21。テスターとアーキテクトの指摘を独立に再現）、文書の該当箇所の確認
