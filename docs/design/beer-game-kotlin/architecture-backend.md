---
type: Design
title: "バックエンドアーキテクチャ - ビールゲームシミュレーション（Kotlin 版）"
description: "Kotlin 版のバックエンドアーキテクチャ。Ktor と Arrow、ES+CQRS のコマンド側と問い合わせ側、関数の束による依存の表し方、PostgreSQL 固有の機能を隠すポート（ProjectionLock・ChangeNotifier）と PostgreSQL 版・H2 版の 2 実装、ローカル開発のプロファイルと本番での H2 の拒否、コマンド処理の流れ、冪等性、競合の再試行、自動確定、SSE、観測性、セキュリティ、モジュール構成と依存の検査を整理した正本。"
tags: [design]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-15T07:43:36Z }
---

# バックエンドアーキテクチャ - ビールゲームシミュレーション（Kotlin 版）

## 概要

本書は、beer-game-kotlin のバックエンドのアーキテクチャを、パターン選択の根拠とあわせて定義します。**`docs/` を設計の正本**とします。実装コードはまだ存在しません。本書の Kotlin のコードは、型と関数の形を示す設計上のスケッチです。

[beer-game2 のバックエンドアーキテクチャ](../beer-game2/architecture-backend.md) の機能・API の振る舞い・セキュリティ・運用要件を正本として引き継ぎ、次の点を **Kotlin・関数型・イベントソーシング（ES）+ CQRS** で設計し直します。

- 書き込みは、`decide` / `evolve`（[ドメインモデル](./domain-model.md)）を呼ぶ**薄いコマンド処理**に集約します。ロック（`SELECT ... FOR UPDATE`）と版つき更新は、追記の一意制約と自動再試行に置き換えます（再構築との同時実行の制御にだけ、ポート `ProjectionLock` を使います。PostgreSQL 版の実体はアドバイザリロックです）（[データモデル](./data-model.md)）。
- 読み取りは、同期投影の表を SQL で読む**問い合わせ側**です。
- 依存は、インターフェースの階層でなく**関数の型の束**で表します（[ガイド §7.2](../../reference/関数型プログラミングガイド_Kotlin編.md)）。
- 失敗は例外でなく `Either` で返し、境界で HTTP の応答へ写します（[ガイド 第 3 章](../../reference/関数型プログラミングガイド_Kotlin編.md)）。
- **ローカル開発（開発機での起動・動作確認）だけは、H2 の PostgreSQL モードでも動かせます**（ユーザーの決定、2026-11-14。[ADR-014](../../adr/beer-game-kotlin/014-h2-for-local-development.md)）。PostgreSQL 固有の機能（アドバイザリロック、LISTEN/NOTIFY）は**ポートの裏に隠し、PostgreSQL 版と H2 版の 2 実装**を持ちます。統合テスト、CI、ステージング、本番は PostgreSQL 18 のままです（下の「ローカル開発（H2）と実行の選択」）。

技術スタックのバージョンは [技術スタック](./tech-stack.md) と [インフラストラクチャ](./architecture-infrastructure.md) の確認結果に従います。本書は、ライブラリの版を断定しません。

## パターンの選択

[アーキテクチャ設計ガイド](../../reference/アーキテクチャ設計ガイド.md) の選択フローに沿って判断します。

| 判断項目 | 本システムの答え | 帰結 |
| :--- | :--- | :--- |
| 業務領域のカテゴリー | 中核の業務領域（週次計算と進行） | ドメインモデルパターン。ルールは `decide` に集める |
| 金額・分析・監査記録 | 分析と記録が必要。**状態の履歴そのものが学習の素材** | **イベントソーシング**。状態はイベントの列。イベントが監査の記録を兼ねる（ユーザーの方針） |
| 永続化モデルが複数か | 書き込み（イベント列）と読み取り（観察・振り返り・出力）で形が異なる | **CQRS**。コマンド側は `events` へ追記、問い合わせ側は投影テーブルを SQL で読む（[ガイド §7.5](../../reference/関数型プログラミングガイド_Kotlin編.md)） |

**採用する構造は、「核の純粋関数 + 外側の薄い副作用の層」です**（[ガイド §7.8](../../reference/関数型プログラミングガイド_Kotlin編.md)）。核は、入力の検証、`decide`、`evolve`、投影、`simulateWeek`、`Disclosure` です。副作用は、HTTP、データベース、時計、乱数、ログです。beer-game2 のポートとアダプターと同じ依存の向きを、関数の型で表します。

## 全体構成

```plantuml
@startuml
title バックエンドの層構造（Kotlin 版）

package "adapter-http（Ktor）" {
  [ルート（機能別）\n入力検証 -> コマンド] as Routes
  [認証・Origin 検査・レート制限\nセキュリティヘッダー・CallId] as Guard
  [エラーの写像（problem+json）] as Err
  [SSE（版の通知）] as SSE
}

package "application" {
  [コマンド処理\nexecute: 読む -> decide -> 追記 -> 投影] as Cmd
  [問い合わせ\nSQL の結果 + Disclosure] as Qry
  [関数の束（Ports）\nEventStore・Clock・IdGen・CredentialIssuer\nIdempotencyStore・ProjectionLock・ChangeNotifier] as Ports
}

package "domain（純粋）" {
  [decideGame / evolveGame] as Game
  [decideSession / evolveSession] as Session
  [startGame] as Start
  [simulateWeek] as Sim
  [Projection（Event -> List<RowChange>。純粋）] as Proj
  [Disclosure・KitPreset・RetentionSaga の decide / evolve] as Svc
  [値オブジェクト・Command・Event・DomainError] as VO
}

package "adapter-persistence（JDBC。PostgreSQL 版と、ローカル用の H2 版）" {
  [EventStore の実装\n追記・版の一意制約] as ES
  [投影の書き込み（SQL）] as PW
  [問い合わせの実装（SQL・読み取り専用ロール）] as QR
  [周辺ストア・冪等記録] as Aux
  [ProjectionLock・ChangeNotifier\nPostgreSQL 版: アドバイザリロック・NOTIFY\nH2 版: プロセス内のロック・イベント] as Port2
}

database "PostgreSQL 18\n（ローカルのみ H2）" as DB

Routes --> Guard
Routes --> Cmd
Routes --> Qry
Routes --> SSE
Routes --> Err
Cmd --> Game
Cmd --> Session
Cmd --> Start
Cmd --> Proj
Cmd --> Ports
Qry --> Svc
Qry --> Ports
Session --> Sim
ES ..|> Ports
PW ..|> Ports
QR ..|> Ports
Aux ..|> Ports
Port2 ..|> Ports
ES --> DB
PW --> DB
QR --> DB
Aux --> DB
Port2 --> DB
@enduml
```

### 層と依存の向き

依存は、外側から内側（ドメイン）への**一方向**です。`domain` は、Kotlin の標準ライブラリと Arrow Core だけに依存します。

| 層（Gradle モジュール） | 責務 | 依存してよい先 |
| :--- | :--- | :--- |
| `domain` | 値オブジェクト、`Command`、`Event`、`DomainError`、`decide` / `evolve`、`replayGame` / `replaySession`、`startGame`、`simulateWeek`、`KitPreset`、投影の純粋関数、`RetentionSaga` の純粋関数。**業務ルールはここにある**（`Disclosure` は B1 の実装では `application`。下の層の表の `application` を参照） | なし（Kotlin 標準ライブラリ、Arrow Core のみ） |
| `application` | 関数の束（`Ports`）の型の定義、コマンド処理 `execute`（B1 の実装では `runCommand`）、問い合わせ、競合の再試行、周辺ストアへの書き込み内容の導出（純粋）、**開示の判定 `Disclosure`（純粋。読み取りの型 `ProjectedGame` と同じ層に置く。B1 の実装。変更 #37）**。トランザクションの境界を決める。**ルールは持たない** | `domain` |
| `adapter-http` | Ktor のルート、DTO の検証（`Either` で誤りを集める）、認証、Origin 検査、レート制限、ヘッダー、SSE、エラーの写像 | `application`、`domain` |
| `adapter-persistence` | JDBC による `EventStore`、投影の書き込み、問い合わせ、周辺ストア、冪等記録、`ProjectionLock` と `ChangeNotifier` の **PostgreSQL 版と H2 版**、イベントの JSON 変換（`EventCodec`）、マイグレーション（共通・PostgreSQL・H2 の場所） | `application`、`domain` |
| `app` | 設定の読み込みと検証、関数の束の組み立て（ワイヤリング）、起動のモード（api、retention、migrate、rebuild-projections） | 全モジュール |

この規則は、**Gradle のモジュール依存**（コンパイル時に import できない）と、**検査のルール**（detekt と PMD のカスタムルール。[ガイド §9.6](../../reference/関数型プログラミングガイド_Kotlin編.md)）の二重で守ります。違反は、CI で失敗とします。

### 依存を関数の束で表す

外部とのやり取りを、`typealias` と `data class` の関数の束で表します（[ガイド §7.2](../../reference/関数型プログラミングガイド_Kotlin編.md)）。テストでは、同じ型の関数に差し替えます。副作用のある関数は `suspend` とし、型で副作用を示します（[ガイド §4.2](../../reference/関数型プログラミングガイド_Kotlin編.md)）。

```kotlin
typealias Now = suspend () -> Instant
typealias NewId = suspend () -> UUID
typealias IssueCredential = suspend (CredentialKind, ExpiresAt) -> IssuedCredential   // 乱数とダイジェスト。生の値は応答だけが運ぶ

/** イベントストア。PostgreSQL 版とインメモリ版を差し替える（データモデルのスケッチと同じ形） */
data class EventStore(
    val read: suspend (Tx, GameId, StreamType) -> Either<AppFailure, StreamRead>,                    // Left は Persistence
    // B1 の実装: 追記後の封筒の列（版つき）を返す。同期投影が版つきの封筒を要するため（Unit ではない）。Left は ConcurrencyConflict か Persistence
    val append: suspend (Tx, Map<StreamType, StreamVersion>, List<NewEvent>) -> Either<AppFailure, List<EventEnvelope<DomainEvent>>>,
    val transaction: TransactionRunner,
)

/**
 * 失敗の型は AppFailure（正本。下の「コマンド処理の流れ」）。追記の競合は AppFailure.ConcurrencyConflict で、独立した AppendFailure の型は持たない。データモデルの署名もこれに合わせる。
 * B1 の実装: 総称のメソッド（`<A>`）を持つので `fun interface` にできない（コンパイルエラーを確認）。通常の `interface`。
 */
interface TransactionRunner {
    suspend operator fun <A> invoke(block: suspend (Tx) -> Either<AppFailure, A>): Either<AppFailure, A>
}

/**
 * コマンドの応答。画面の表示に使う内容は持たない（ストリームごとの追記後の版だけ）。
 * B1 の実装: `gameId`（作成の再送が同じゲームを返すため）と、資格を発行した操作（作成・参加）の `issued`（資格の生の値。冪等記録は暗号化して保存）を持つ。
 * HTTP が応答の本文に載せるのは `versions` だけ（`gameId` は Location、資格は Set-Cookie）。
 */
data class CommandOutcome(val gameId: GameId, val versions: Versions, val issued: IssuedCredential? = null)
/** 追記したストリームの版だけを持ち、追記しなかったストリームは null（追記が空の列だったときは、そのストリームの現在の版） */
data class Versions(val game: StreamVersion?, val session: StreamVersion?)

/**
 * 追記と同じトランザクションで書く、イベント以外の行。B1 の実装は、設計の `SideStores` を 3 つのポートに分けた
 * （投影の書き込み `ProjectionWriter`、冪等記録 `IdempotencyStore(find, save)`。`save` は期限切れの置き換えのため時刻 `now` を受け取る、
 * 周辺ストア `PeripheralStore`）。周辺ストアの書き込み内容は、純粋な導出 `peripheralWrites` のまま。
 */
fun interface ProjectionWriter {
    suspend fun write(tx: Tx, gameId: GameId, events: List<EventEnvelope<DomainEvent>>): Either<AppFailure, Unit>
}
// IdempotencyStore(find, save)、PeripheralStore（display_profiles・credentials・browser_sessions の書き込み、資格の認証、参加コードからのゲームの照合）は application/Ports.kt・Credentials.kt

/**
 * 投影の再構築との直列化（ゲーム単位）。PostgreSQL 固有のアドバイザリロックをポートの裏に隠す。
 * 取るだけで、解放の関数は持たない（トランザクションの終了で、COMMIT・ROLLBACK のどちらでも自動で解放される）。
 * 待ちが上限を超えたら Left(RetryExhausted)
 */
data class ProjectionLock(
    val acquireShared: suspend (Tx, GameId) -> Either<AppFailure, Unit>,      // コマンド。共有どうしは待ち合わない
    val acquireExclusive: suspend (Tx, GameId) -> Either<AppFailure, Unit>,   // 再構築。共有・排他のすべてを待つ
)

/**
 * 版の通知（SSE の元）。PostgreSQL 固有の LISTEN/NOTIFY をポートの裏に隠す。
 * publish は追記と同じトランザクションで呼び、コミットされたときだけ配信される（ロールバックでは配信されない）
 */
data class ChangeNotifier(
    val publish: suspend (Tx, List<VersionNotice>) -> Either<PersistenceFailure, Unit>,
    val subscribe: () -> Flow<VersionNotice>,        // 受信。切断からの再接続は実装が持つ
    val isAlive: suspend () -> Boolean,              // /ready が見る（受信の接続が生きているか）
)

/**
 * B1 の実装: detekt の引数の数の規則を、設定を緩めずに守るため、束ねた 5 項目にした（`now` などは同じ名前のプロパティでも読める）。
 * `Generators(now, newId, newCredential, newJoinCode)`（資格の生の値と参加コードの乱数を含む。旧 `IssueCredential`）、
 * `Stores(events, project, idempotency, peripheral, reader)`（`reader` は投影の読み取り専用のトランザクション）、
 * `AppSettings`（再試行の上限、冪等記録の期限、資格の期限、鍵の版と鍵）
 */
class Ports(val generators: Generators, val stores: Stores,
            val lock: ProjectionLock, val notifier: ChangeNotifier, val settings: AppSettings)
```

**`ProjectionLock` と `ChangeNotifier` は、PostgreSQL 版と H2 版の 2 実装を持ちます**（どちらも `adapter-persistence`。`app` が設定で選んで組み立てる）。

| ポート | PostgreSQL 版（統合テスト・CI・ステージング・本番） | H2 版（ローカルのみ） | 契約テスト |
| :--- | :--- | :--- | :--- |
| `ProjectionLock` | `pg_advisory_xact_lock_shared`（共有）、`pg_advisory_xact_lock`（排他）。`lock_timeout` 超過（SQLSTATE 55P03）を `RetryExhausted` に写す | **プロセス内の読み書きロック**（ゲームごと。読み取り側が共有、書き込み側が排他）。トランザクションの終了のフックで解放。待ちには上限を置き、超えたら `RetryExhausted`。**単一プロセスでのみ有効（複数プロセスでは保証しない）** | 共有どうしは待ち合わない、排他は共有を待つ、トランザクションの終了で解放（ROLLBACK でも）、上限超過で `RetryExhausted` |
| `ChangeNotifier` | `pg_notify` と、専用の LISTEN 接続（プールの外。1 タスクに 1 本）。NOTIFY の欠落は数秒ごとの照合で補う | **プロセス内のイベント**（`MutableSharedFlow`）。`publish` はトランザクションの COMMIT 後に配信し、ROLLBACK では捨てる。**単一プロセスでのみ有効** | コミットで配信、ロールバックでは配信されない、ゲームごとの絞り込み、購読の再接続 |

契約テストは**同じ内容を両実装で実行**します（PostgreSQL 版は統合テスト、H2 版はユニットテスト。[テスト戦略](./test-strategy.md)）。契約を満たす範囲が、H2 版で保証する範囲のすべてです（H2 版は PostgreSQL の挙動の再現を目指さない）。

**`EventStore.transaction` の意味論**は次のとおりです。

| 項目 | 設計 |
| :--- | :--- |
| 原子性 | ブロックが `Left` を返したら **ROLLBACK**。追記と投影（周辺ストア・冪等記録・通知を含む）は、同じトランザクションで、全部成功か全部失敗のどちらか。投影が `Left` を返したら、追記も取り消される |
| 分離レベル | **READ COMMITTED**。競合の検出は、分離レベルでなく `events` の一意制約（`uq_events_stream_version`）で行う。H2 版でも同じ指定をするが、H2 の PostgreSQL モードで同じ動作になるかは確認できなかった。分離レベルの検証は PostgreSQL の統合テストだけで行う |
| ロック（再構築との同時実行） | コマンドのトランザクションは、`BEGIN` の直後に **`ProjectionLock.acquireShared(tx, gameId)`** を取る（コマンドどうしは互いを待たない）。投影の再構築は `acquireExclusive` を取り、コマンドと同時に走らない（下の「投影の更新と再構築」）。PostgreSQL 版の実体は `pg_advisory_xact_lock_shared(game_id)` / `pg_advisory_xact_lock(game_id)` で、`game_id` は UUID から導いた 64 ビット整数に写す（衝突は不要な待ちを生むだけで、整合性は損なわない）。H2 版はプロセス内の読み書きロック（単一プロセスのみ）。どちらも、トランザクションの終わりで自動的に解放される |
| 再試行の対象 | `AppFailure.ConcurrencyConflict`。アダプターは、`uq_events_stream_version` の違反、SQLSTATE **40001**（直列化失敗）、**40P01**（デッドロック）をすべて `ConcurrencyConflict` に写す。`execute` が、読み込みからやり直す（上限つき） |
| キャンセル | COMMIT と ROLLBACK は **`NonCancellable`** で行う。`CancellationException` は握りつぶさず、**再送出**する（`PersistenceFailure` に変えない）。クライアントの切断でコルーチンがキャンセルされても、トランザクションは必ず閉じる |

`decide` は `Now` や `NewId` を持ちません。時刻、`GameId`、`JoinCode`、`ParticipantId` などは、ルートがコマンドの値に詰めてから `execute` へ渡します（[ドメインモデル](./domain-model.md) 変更 12、[ガイド §4.4](../../reference/関数型プログラミングガイド_Kotlin編.md)）。

## コマンド側

### コマンド処理の流れ

[ガイド §7.8](../../reference/関数型プログラミングガイド_Kotlin編.md) の流れ（HTTP → 検証 → コマンド → `handle` → ストア → 射影）を、本システムに当てはめます。

```plantuml
@startuml
title コマンド処理（意思決定の保存と自動確定）

actor 参加者 as P
participant "ルート\n（Ktor）" as R
participant "execute\n（application）" as X
participant "decideSession\n（domain・純粋）" as D
participant "EventStore\n（JDBC）" as ES
database "PostgreSQL" as DB

P -> R : PUT /sessions/:id/decisions\n（Idempotency-Key、If-Match = 意思決定の版）
R -> R : 本文の検証（誤りを集める）-> SaveDecision\n生の資格（Cookie の値）を RequestMeta.credential に入れる（Actor は作らない）
R -> X : execute(command, key)
X -> DB : BEGIN（READ COMMITTED）
X -> X : ProjectionLock.acquireShared(tx, game_id)\n（PostgreSQL 版: アドバイザリロック。H2 版: プロセス内）
X -> X : 認証（操作者・資格の有効性）-> Actor（B1 の実装: トランザクションの中。再試行のたびに評価し直す）\n認可の前提検査（ゲームの一致、資格の種別）
X -> DB : 冪等記録を照合（同じキー・対象・操作者）
alt 記録あり、要求のダイジェスト（本文・対象・操作者）が同じ
  X --> R : 保存した成功の応答をそのまま返す
else 記録あり、ダイジェストが違う
  X --> R : app.idempotency_key_reused（409）
else 記録なし
  X -> ES : read(session) -> イベント列と版 N
  X -> X : replay = fold(evolveSession)
  X -> D : decideSession(state, command)
  alt Left(DomainError)
    D --> X : 失敗 -> ROLLBACK（保存しない。再送は同じ失敗を再計算する）
  else Right(events)（自動確定なら DecisionSaved + WeekCommitted）
    D --> X : events
    X -> ES : append(期待する版 N, events)\n一意制約 (game, stream, version)
    alt 違反（別のコマンドが先に追記）
      ES --> X : ConcurrencyConflict -> ROLLBACK し再試行
    else 成功
      X -> DB : 投影を更新（追記の後）\n周辺ストア、冪等記録（成功の応答だけ）
      X -> X : ChangeNotifier.publish(tx, 版の通知)\n（コミットで配信。PostgreSQL 版: pg_notify）
      X -> DB : COMMIT
    end
  end
end
X --> R : Either<AppFailure, CommandOutcome>
R --> P : 200（versions のみ）/ 問題の応答
@enduml
```

```kotlin
/** アプリケーション層の失敗の唯一の正本。EventStore、execute、ルートの写像がすべてこの型を使う（データモデルの署名も同じ） */
sealed interface AppFailure {
    data class Invalid(val errors: NonEmptyList<ValidationError>) : AppFailure       // 境界で集めた入力の誤り（ルートが execute の前に作る）
    data class Domain(val error: DomainError) : AppFailure                           // decide が返した業務上の失敗
    data object ConcurrencyConflict : AppFailure                                     // 追記の競合。uq_events_stream_version の違反、40001、40P01。execute が再試行する
    data object RetryExhausted : AppFailure                                          // 競合の再試行が上限に達した、または再構築のロックの待ちが上限に達した。app.retry_exhausted（503、Retry-After）
    data object IdempotencyKeyReused : AppFailure                                    // 同じキーで要求の内容（本文・対象・操作者）が違う。app.idempotency_key_reused（409）
    data object Unauthorized : AppFailure                                            // 資格が無効（失効・期限切れ・不明を区別しない）。app.unauthorized（403）
    data class Persistence(val failure: PersistenceFailure) : AppFailure             // 例外を境界で値にしたもの。500 と相関 ID
}

/** 1 本のストリームのコマンド。ストリームごとの decide / evolve を渡すだけで、ルールは持たない */
suspend fun <S, C, E> Ports.execute(
    stream: StreamRef, initial: S, evolve: (S, E) -> S,
    decide: (S, C) -> Either<DomainError, List<E>>,
    command: C, ctx: CommandContext,
): Either<AppFailure, CommandOutcome> =
    withAppendRetry(ctx.maxAttempts) {
        events.transaction { tx ->
            either {
                // 順序: ロック -> 認証 -> 認可の前提検査 -> 冪等記録の照合 -> 読み込み -> decide -> 追記・投影
                // （B1 の実装: 認証は execute の中。ADR-004 の順序を、再試行のたびに、同じトランザクションの中で守るため）
                lock.acquireShared(tx, stream.gameId).bind()                  // 再構築との直列化（ポート。待ちの上限超過は RetryExhausted）
                ctx.authorizePrecheck(tx).bind()                              // 認証（資格の有効性）と、ゲームの一致。無効なら Unauthorized（403）
                side.findIdempotent(tx, ctx.key).mapLeft(AppFailure::Persistence).bind()
                    ?.let { return@either ctx.replayStored(it).bind() }       // 成功の応答だけが保存されている。digest（本文・対象・操作者）が違えば IdempotencyKeyReused
                val read = events.read(tx, stream.gameId, stream.type).bind()
                val state = read.events.fold(initial, evolve)                  // 再生（純粋）
                val decided = decide(state, command).mapLeft(AppFailure::Domain).bind()
                events.append(tx, mapOf(stream.type to read.version), decided.toNew(ctx, read.version)).bind()
                side.project(tx, stream.gameId, decided.enveloped(ctx, read.version)).mapLeft(AppFailure::Persistence).bind()
                // 周辺ストアも同じ tx で書き、通知は notifier.publish(tx, …) で積む（省略）。冪等記録は、成功の応答（versions）だけを保存する
                // decide が Left のときは、冪等記録を書かない。ブロックが Left を返すので transaction が ROLLBACK する
                val outcome = CommandOutcome(Versions(/* 追記したストリームの追記後の版 */))
                side.saveIdempotent(tx, ctx.key, outcome.toStored()).mapLeft(AppFailure::Persistence).bind()
                outcome
            }
        }
    }

/** AppFailure.ConcurrencyConflict だけを再試行する（アダプターが、版の違反・40001・40P01 をこの値に写している）。業務上の競合（DecisionConflict など）は decide が返すので再試行しない */
tailrec suspend fun <A> withAppendRetry(
    remaining: Int, block: suspend () -> Either<AppFailure, A>,
): Either<AppFailure, A> =
    when (val r = block()) {
        is Either.Left ->
            when {
                r.value is AppFailure.ConcurrencyConflict && remaining > 1 -> withAppendRetry(remaining - 1, block)
                r.value is AppFailure.ConcurrencyConflict -> AppFailure.RetryExhausted.left()
                else -> r
            }
        is Either.Right -> r
    }
```

要点は次のとおりです。

- **`execute` はストリームの種類に依存しません。** `GameState` と `SessionState` の違いは、渡す `initial`、`evolve`、`decide` だけです。ルートが「どのコマンドをどのストリームへ流すか」の表を持ちます（下の API の表）。
- **`StartGame` だけ**は、`game` と `session` の両ストリームを読み、`startGame` の結果を、両方の期待する版を持って 1 回の追記で書く別の関数（B1 の実装では `applyStart`。1 本のストリームは `applySingle`）にします（[ガイド §7.6](../../reference/関数型プログラミングガイド_Kotlin編.md) の複数ストリームのコマンド）。
- **処理の順は固定**です。ロック（共有）→ 認証（操作者・資格の有効性）→ 認可の前提検査 → 冪等記録の照合 → 読み込み → `decide` → 追記・投影 → 周辺ストア → 通知 → 冪等記録の保存。**認証は `execute`（B1 の実装では `runCommand`）の中で、同じトランザクションの中で行います**（ルートは生の資格を渡すだけで、`Actor` を作らない。コマンドの `actor` は、認証の結果から `execute` の中で作る）。ロックは認証より前に取り、`game_id` は呼び出し側が決めます。**参加（`joinGame`）だけ**は、参加コードからゲームを引く必要があるので、別の短いトランザクション（読み取りだけ）で参加コードの照合を先に行います。ポートの呼び出しの順は `ExecuteSpec` が固定します。認可を冪等記録の照合より**先**に置くため、入れ替えで失効した旧担当者が過去のキーを再送しても 403 になり、保存済みの応答（参加・復帰では資格の生の値）は返りません。
- **冪等記録に保存するのは、成功した応答だけ**です。業務の失敗（`Left`）は保存せず、再送は同じ失敗を再計算して返します。保存する応答は `versions`（追記後の版）だけです（H8）。
- 追記は **`decide` が空の列を返したときは行いません**（同じ役割への再割り当てなど）。冪等記録だけを書きます（このとき、同時の重複は `pk_idempotency_records` で検出します。下の冪等性の節）。
- **自動確定のための特別な処理はありません。** `decideSession` が `DecisionSaved`（または `ProxyDecisionSubmitted`）と `WeekCommitted`（と `SessionEnded`）を 1 回の戻り値で返すため、`execute` から見ると、複数イベントの追記が 1 回あるだけです。手動と自動の確定が同時に起きても、2 回目は追記が版の違反となり、再試行後の `decide` が `WeekAdvanced` または `AlreadyEnded` を返します（確定は一度だけ）。
- **投影は追記の後に更新します**（同じトランザクション）。追記で一意制約に負けたコマンドは、投影を更新する前に失敗するので、投影の書き込みどうしが競合しません。`game_overview` は `game` と `session` の両方のイベントから更新されるため、複数の投影の行を書くコマンドが並びうる点は、**ロックの順序の規則**で守ります（下の「投影の行のロックの順序」、設計判断 BD6）。イベントストアにはロックを使いません。
- **コマンドは、トランザクションの先頭でポート `ProjectionLock.acquireShared` を取ります**（再構築との同時実行の制御。M23。PostgreSQL 版は `pg_advisory_xact_lock_shared(game_id)`）。取れるまでの待ちには上限（PostgreSQL 版は `lock_timeout`）を置き、超えたら `AppFailure.RetryExhausted`（503、`Retry-After`）を返します。上限の値と、再構築中のコマンドの応答（短く待つか、すぐ 503 を返すか）は未決事項です。

### 周辺ストアへの書き込み

表示名と資格のダイジェストはイベントに入れません（ドメインモデル D7）。コマンドが運んだ値（`DisplayName`、`IssuedCredential`）から、追記と同じトランザクションで書く内容を、**純粋関数で導出**します。

```kotlin
sealed interface PeripheralWrite {
    data class SaveDisplayName(val gameId: GameId, val subject: ActorRef, val name: DisplayName) : PeripheralWrite
    data class IssueCredentialRow(val gameId: GameId, val digest: CredentialDigest, val kind: CredentialKind,
                                  val subjectId: UUID, val keyVersion: Int, val expiresAt: Instant) : PeripheralWrite
    data class RevokeCredentialRow(val gameId: GameId, val subject: CredentialSubject, val at: Instant) : PeripheralWrite
}
fun peripheralWrites(command: GameCommand, issued: IssuedCredentials, events: List<GameEvent>): List<PeripheralWrite>
```

「`credentials` の発行・失効が、対応する `Credential*` などのイベントと必ず一緒に起きる」ことは、統合テストで確認します（[データモデル](./data-model.md)）。

### 冪等性

[データモデル](./data-model.md) の仕組み（`idempotency_records`、24 時間、応答を暗号化）を、次のように実装します。

| 項目 | 設計 |
| :--- | :--- |
| キー | 変更系は `Idempotency-Key` を必須とする。`scope` は「操作の名前 + 対象」（例: `decision:RETAILER`）。保存するのはキーのダイジェスト |
| 要求の同一性 | `request_digest` = 正規化した本文・対象・**操作者の ID** の HMAC。同じキーで違う内容（別の操作者を含む）は `app.idempotency_key_reused`（409） |
| 照合の位置 | **認証と認可の前提検査の後**、読み込みの前。失効した資格が過去のキーを再送しても 403 で、保存済みの応答は返さない |
| 保存する内容 | **成功した応答（`versions`）だけ**。業務の失敗（`Left`）は保存しない。再送は同じ失敗を再計算して返す |
| 書き込み | 追記と同じトランザクション。検索は、認可の前提検査の直後（再試行のたびに行う） |
| 同時の重複 | 同じキーの 2 つの要求が同時に来ても、追記の版の違反（`uq_events_stream_version`）で一方が負け、**再試行で記録を見つけて**同じ応答を返す。**空の列を返す操作**の同時の重複は、`pk_idempotency_records` の違反を `ConcurrencyConflict` に写し、`execute` の再試行が `find` で記録を見つける（B1 の実装。PostgreSQL では一意違反の後のトランザクションが使えず、同じトランザクションで再照合できないため。下の競合の再試行の表。実 DB の並行での検証は未実施） |
| ゲーム作成 | 新しい `game_id` を採り、`scope = 'create'` の部分一意索引（`uq_idempotency_create`）で重複を検出する。違反は同じく `ConcurrencyConflict` に写し、再試行で記録を見つけて保存済みの応答を返す（500 にしない） |
| 応答 | 資格の生の値を含む操作（作成、参加、復帰）の応答は、鍵付きで暗号化して保存する。暗号化と復号は境界（`adapter-persistence`）が行い、鍵は Secrets Manager から注入する |
| 掃除 | `expires_at` を過ぎた行を、定期のタスクで削除する（ゲームの保持削除とは別） |

### 競合の再試行

再試行・再照合の対象にする**一意制約を名前つきで一覧**にします。正本は [データモデル](./data-model.md) で、同じ表を持ちます。

| 制約名 | 表 | 衝突の意味 | 扱い |
| :--- | :--- | :--- | :--- |
| `uq_events_stream_version` | `events` | 同じストリームへの同時の追記 | 読み直して `decide` からやり直す（`ConcurrencyConflict`、上限つき） |
| `uq_idempotency_create` | `idempotency_records`（`scope='create'` の部分一意索引） | 同じキーのゲーム作成の同時の重複 | `ConcurrencyConflict` に写し、`execute` の再試行で記録を見つけて、保存済みの応答を返す（500 にしない。B1 の実装） |
| `pk_idempotency_records` | `idempotency_records` | 同じキー・同じ対象の同時の重複（空の列を返す操作を含む） | 同上。再試行の `find` が、本文の digest が同じなら保存済みの応答、違えば `app.idempotency_key_reused`（409）を返す |

上の 3 つ以外の一意制約違反は、設計上起きないはずなので、**500 と相関 ID（ログ）**とします。

**H2 版（ローカルのみ）では、`uq_idempotency_create`（部分一意索引）を省略します**（H2 の PostgreSQL モードで使えることを公式ドキュメントで確認できなかったため）。代わりに、アプリケーション側で、挿入の前に `(scope, key_digest)` を検索し、重複が見つかれば `ConcurrencyConflict` を返します（B1 の実装。同じ契約の試験が両方で通った）。ローカルでは、ゲーム作成の同時の重複は制約で守られません（[データモデル](./data-model.md)）。

| 種類 | 発生源 | 扱い |
| :--- | :--- | :--- |
| `ConcurrencyConflict`（追記の版の違反）、SQLSTATE 40001・40P01 | `events` の一意制約、直列化失敗、デッドロック | **`execute` が自動で再試行する**（再読み込み -> 再評価）。上限は小さな固定回数で、実装開始時に競合の頻度を測って決める（[データモデル](./data-model.md)）。上限に達したら `AppFailure.RetryExhausted`（`code` = `app.retry_exhausted`、**503 と `Retry-After`**。利用者に操作し直しを促す） |
| `DecisionConflict` | `decide`（意思決定の版が古い） | 再試行しない。409 で、最新値と最後の保存者を返す（変更を黙って失わせない） |
| `WeekAdvanced`、`DecisionsChanged`、`AlreadyStarted`、`AlreadyEnded` | `decide` | 再試行しない。409 で、現在の状態を示す（`DecisionsChanged` は現在の値と保存者を返す） |
| `IdempotencyKeyReused` | 冪等記録 | 再試行しない。409（`app.idempotency_key_reused`） |
| `Unauthorized` | 認可の前提検査 | 再試行しない。403（`app.unauthorized`） |

再試行は、**認可を含めて `decide` を最初から評価し直す**ため、再読み込みの後に権限や状態が変わっていても正しく判定します。再試行のあいだに待ちは入れず、上限に達しても失敗が続くときは、遅延を足す（ジッターつきの `Schedule`。[ガイド §4.3](../../reference/関数型プログラミングガイド_Kotlin編.md)）かどうかを、計測して決めます（未決事項）。

### 永続化の境界

JDBC のブロッキング I/O は、`withContext(Dispatchers.IO)` に閉じ込め、例外は `Either.catch` で `PersistenceFailure` に変換します（[ガイド §7.6](../../reference/関数型プログラミングガイド_Kotlin編.md)）。一意制約の違反（SQLSTATE `23505`）は、**制約の名前**で見分けます。`uq_events_stream_version`・`uq_idempotency_create`・`pk_idempotency_records` は `AppFailure.ConcurrencyConflict`（冪等記録の重複は、再試行の `find` が見つける）、それ以外は `AppFailure.Persistence`（500 と相関 ID）です（上の表）。SQLSTATE 40001 と 40P01 も `AppFailure.ConcurrencyConflict` に写し、同じ再試行の対象にします。アドバイザリロックの待ちが `lock_timeout` を超えたとき（SQLSTATE 55P03）は `AppFailure.RetryExhausted` に写します（これらの写像は PostgreSQL 版のアダプターのもの。**H2 版は B1 で実測して確定した**: PostgreSQL は `PSQLException.serverErrorMessage.constraint`（部分一意索引も索引名で取れる）、H2 は専用のフィールドが無く、メッセージに制約名が含まれる（`DATABASE_TO_LOWER=TRUE` では小文字）ので、大文字小文字を区別せず探す。**H2 のメッセージには行の値（`VALUES (...)`）も含まれるため、`PersistenceFailure` にメッセージを載せない**（SQLSTATE と制約名だけ。PostgreSQL も詳細を除く主メッセージだけ）。詳細は [データモデル](./data-model.md) のローカル開発）。キャンセルの扱いは、`EventStore.transaction` の意味論に従います（`CancellationException` を `Persistence` に変えない）。

## 問い合わせ側

問い合わせは、イベントストアを経由せず、**投影の表を SQL で読む**ことで返します。

| 項目 | 設計 |
| :--- | :--- |
| 読み込み | 読み取り専用のデータベースロールで、投影の表を SELECT する。1 つの問い合わせは、1 つの画面の分だけを返す |
| 開示 | 取得した行に、純粋関数 `Disclosure` を掛ける（将来の需要の除外、寄与者数が 2 未満の合計の抑止、終了後だけ全役割）。**表の選択**も、利用者の種別で決める |
| 観察者 | 観察者の問い合わせが読む表は、**`game_overview`（参加コードを含まない）、`session_overview`、`week_team_totals` の 3 表に統一**する。**別の読み取り専用ロール（接続プール）**を使い、役割別の表（`week_role_results`、`role_current_states`、`current_decisions`）と、**参加コードを持つ `game_join_codes`** に DB の権限として到達できない（[データモデル](./data-model.md) の最小権限。NF-S18）。観察者に参加コードが見えると参加者として加われるため（FR-17・BR-17） |
| 参加コード | `join_code` は `game_overview` から分け、投影の表 **`game_join_codes(game_id, join_code)`** に置く。読むのは**進行役・参加者の問い合わせだけ**（読み取り用のロール）。観察者のロールには、この表の SELECT を与えない |
| 版 | 応答に、どのストリームの、どの版までを反映したか（`projection_checkpoints.projected_version`）を載せる。画面は版で新旧を判断する（[フロントエンド](./architecture-frontend.md)） |
| 一貫した読み取り | 問い合わせは、**読み取り専用の REPEATABLE READ のトランザクション**で行い、**`projection_checkpoints` を同じトランザクションで読む**。応答の `versions` が、同じ応答の行より新しくならない（行より新しい版を返すと、画面が通知を捨てて古い表示のまま残る）。複数の表を読む問い合わせも、同じ時点の行を返す。これは、投影の再構築（1 つのトランザクションで置き換え）の途中の状態を読まないことにもなる |
| 表示名 | `display_profiles` を結合する。読めるのは、そのゲームの操作者だけ |
| 一貫性 | 同期投影なので、追記が成功した後の問い合わせは必ず反映済み。通知を受けて取得した状態の版は、通知の版以上。コマンドの応答の `versions` 以上の版のスナップショットを、画面は取得できる |
| 出力 | 出力のパッケージは**要求時に生成**する。全域の純粋関数 `buildExport(settings, weekRoleResults): ExportPackage`（`Either` を返さない）が、`week_role_results` と設定から作り、`checksum` と `schema_version` も要求時に算出する。**表 `export_packages` は持たない**ため、最終週の確定は出力の作成に依存しない。大きい場合のキャッシュは将来の検討（未決事項） |

### 投影の更新と再構築

- 投影の更新は、`Projection`（純粋。`Event -> List<RowChange>`）と、SQL への書き込み（境界）に分けます。`RowChange` は、行の変更（Upsert / Delete と、表・主キー・値）です。**投影は他の投影を読まず、イベントのペイロードだけから行の変更を作る**ため、再構築の順序に依存しません。1 件の `WeekCommitted` が複数の表の変更を返せます。境界は、返された `RowChange` を同じトランザクションで適用します（[ドメインモデル](./domain-model.md)）。
- 投影の再構築は、`app` の `rebuild-projections` モード（運用のタスク）で行います。**1 ゲームを 1 トランザクション**で、排他のロック（`ProjectionLock.acquireExclusive`。PostgreSQL 版は `pg_advisory_xact_lock(game_id)`）を取り、ゲームの投影の行を削除し、`events` を版の順に畳み込んで `RowChange` を適用し、`projection_checkpoints` を更新します。コマンドは共有のロックを取るので、**再構築と同時には走りません**（待つ）。問い合わせは REPEATABLE READ なので、置き換えが終わるまで古い行を読み、途中の状態を読みません（PostgreSQL の場合。H2 版では分離の動作を検証しない）。**H2 版のロックはプロセス内なので、`rebuild-projections` を API と別のプロセスで動かすと直列になりません**（ローカルでは API を止めてから再構築する）。
- **研修中の運用**: 投影が不整合になったら、運用担当が運営者を通じて進行役に「停止」を依頼し、**停止中に再構築して再開**します。停止中でも追記を伴う操作（代理入力、資格の再発行、観察者の参加）は走りうるため、上のロールによって再構築と直列化します。これにより「研修中は再構築しない」という制約を外します（[運用要件](./operation.md) の手順 B-1 と障害パターン 13）。**暫定の決定で、人の確認が要ります。**

#### 投影の行のロックの順序

1 つのトランザクションで複数の投影の行を更新するときは、**デッドロックを避けるため、順序の規則に従います**。(1) ロックの順は「`pg_advisory_xact_lock_shared`（または排他）→ 投影の表を表名の辞書順 → 同じ表では主キーの昇順」。(2) 1 件のコマンドが返す `RowChange` は、適用の前にこの順に並べ替える。(3) `events` の追記は、投影の更新より前に行う（既存の順序）。それでも検出された 40P01 は、`ConcurrencyConflict` と同じく再試行します。なお、**設計判断 BD6 の `FOR UPDATE`（`game_overview` の行ロック）は、`RowChange` が行の読み込みを要さなくなったため、今のイベント構成では実際には競合を防いでいません**（`game` と `session` のイベントは別の列を更新し、行の UPDATE は暗黙の行ロックで直列化される）。実装開始時に、明示的な `FOR UPDATE` を残すか判断します（未決事項）。
- 次の 3 つの性質を、別の名前で確認します（旧称の「再生の同値性」は使いません）。(a) **永続化往復の同値性**: コマンド実行中のメモリ上の状態と、DB から読んだイベントを再生した状態が一致する（シリアライズ、アップキャスト、版の順序を通る）。(b) **計算と事実の一致**: `fold(evolve)` の結果が、イベントのペイロード（`nextStates` など）と `simulateWeek` を直接回した結果に一致する（[ドメインモデル](./domain-model.md) D5）。(c) **投影の整合**: `fold(evolve)` の結果と投影の行が一致する（運用で日次に検査する）。

## イベントの JSON 変換

| 項目 | 設計 |
| :--- | :--- |
| 場所 | `adapter-persistence` の `EventCodec`。**ドメインのイベントには、シリアライズの注釈を付けない**（設計判断 BD5） |
| 形 | 永続化用の DTO（**kotlinx.serialization**。`@Serializable`、`@SerialName` で `event_type` を固定。決定済み）と、ドメインイベントの相互変換（`EventCodec`）。`schema_version` を持つ。**アップキャストは `adapter-persistence` が持つ** |
| アップキャスト | 旧版の DTO を新版へ変換する純粋関数の列。読み込み時に、`evolve` へ渡す前に適用する（[データモデル](./data-model.md) の規則） |
| 網羅の検査 | 変換は `when` で網羅し、イベントの追加でコンパイルが失敗する。全イベントの往復（`encode` -> `decode`）の性質テストを置く |
| 秘匿 | **永続化の DTO（イベント）** に、表示名・資格の値・招待コードの値のフィールドを**持たせない**（型で防ぐ）。応答の本文には、再発行・作成の復帰コードを一度だけ載せる例外がある（上の「応答とスナップショット」。HTTP の応答の層だけで、イベントには入らない） |

## API 設計方針

- 方式は **REST + JSON**（`/api/v1`）。リアルタイム通知は SSE。beer-game2 と同じです。
- エラーは `application/problem+json`（`type`、`title`、`status`、`detail`、`code`、`correlationId`）。`code` は小文字のドット区切り `<領域>.<名前>`（例: `session.week_advanced`）、`type` は `/problems/{code}`（相対 URI）で、**同じ値を 2 通りに表したもの**です。**予期しないエラーは、相関 ID つきで必ず記録する。**
- 変更系は `Idempotency-Key` を必須とする。**`If-Match` は `SaveDecision`（意思決定の版）にだけ付けます**（beer-game2 は「版」と一括りでした）。

| 版・前提の運び方 | 対象 | コマンドの項目 |
| :--- | :--- | :--- |
| `If-Match` = 意思決定の版（`DecisionVersion`） | `PUT /sessions/:id/decisions` | `SaveDecision.expectedDecisionVersion` |
| 本文に `requestedWeek` と `basis`（役割ごとの意思決定の版）。`If-Match` は使わない | `POST /sessions/:id/weeks/:week/commit` | `CommitWeek(requestedWeek, basis: RoleMap<DecisionVersion>)` |
| 本文に `requestedWeek` を持つ。意思決定の版は要求しない | `PUT /sessions/:id/proxy-decisions/:role` | `SubmitProxyDecision(requestedWeek, …)` |
| 不要 | そのほか | 追記の競合は、サーバーが再試行で吸収する |

- コマンドの**応答**は、`{ versions: { game, session } }`（追記後のストリームごとの版）だけを返します。画面の表示は応答から作りません（下の「応答とスナップショット」）。

- 認証は、Cookie（`HttpOnly`、`Secure`、`SameSite=Strict`）の資格。**資格には有効期限と失効があり、鍵は版を持つ。** B1 の実装: Cookie の名前は `bg_session`（`HttpOnly`、`SameSite=Strict`、`Path=/`、`Max-Age`。**`Secure` は HTTPS の環境だけ**）。`Max-Age` は、B1 では進行役も参加者も 30 日（参加者の資格の期限。進行役の保持日数 90 日より短い。復帰が無い B1 は、ブラウザセッションと復帰資格を 1 つの値で兼ねた。B5 で別のダイジェストに分け、セッションを 24 時間にする想定）。
- 変更系は、Origin（または Referer）を検査する。セキュリティヘッダー（CSP、HSTS、`nosniff`、Referrer-Policy）をすべての応答に付ける。
- すべての応答に `x-correlation-id` を付ける。

### エンドポイントとコマンドの対応

エンドポイントの区分、認可は beer-game2 と同じです。コマンドの流れる先のストリームを加えます。

| 区分 | エンドポイントの例 | コマンド（ストリーム） | 認可 |
| :--- | :--- | :--- | :--- |
| ゲーム | `POST /games` | `CreateGame`（`game`） | 誰でも可 |
| | `GET /games/:id/lobby` | （問い合わせ。`lobby_*`） | 進行役、参加者（**B1 の実装は進行役だけ**。参加者向けのロビーは、投影の型に項目が無く未実装で、参加者には 403。未決事項） |
| | `GET /games/:id/state` | （問い合わせ。呼び出した人ごとの投影。**B1 の実装で追加**） | 進行役（準備中の参加コード・ロビー・開始後の全役割）、参加者（自分の役割と `participantId`）。無資格・別のゲームは 403。`sessionId` は `gameId` と同じ（ドメインモデル） |
| | `PUT /games/:id/participants/:pid/role` | `AssignRole`（準備中は `game`。**開始後は役割の入れ替えで、`game` + `session` の 2 ストリーム**。B5 Step 3.5。アプリケーション層が、ゲームの状態で `decideGame` と `assignRoleAfterStart` を呼び分ける。提案。ゲート 3.5 で人が確認する） | 進行役 |
| | `DELETE /games/:id/participants/:pid/role` | `UnassignRole`（`game`） | 進行役 |
| 参加 | `POST /participations/join` | `JoinGame`（`game`） | 参加コード |
| | `POST /participations/recover` | `RecoverParticipation`（`game`） | 復帰資格（進行役を含む） |
| 観察 | `POST /games/:id/observer-invitations` | `InviteObserver`（`game`） | 進行役 |
| | `DELETE /games/:id/observer-invitations/:invid` | `RevokeObserverInvitation`（`game`） | 進行役 |
| | `POST /observers/join` | `JoinAsObserver`（`game`） | 観察用の招待コード |
| 進行 | `POST /games/:id/start` | `startGame`（`game` + `session`） | 進行役 |
| | `POST /sessions/:id/{pause,resume,end}` | `PauseSession`、`ResumeSession`、`EndSession`（`session`） | 進行役 |
| | `POST /sessions/:id/weeks/:week/commit` | `CommitWeek(requestedWeek, basis)`（`session`）。本文に `requestedWeek` と `basis` | 進行役 |
| | `PUT /sessions/:id/commit-mode` | `SetCommitMode`（`session`） | 進行役 |
| 意思決定 | `PUT /sessions/:id/decisions` | `SaveDecision`（`session`） | 参加者（その役割の共同担当） |
| | `PUT /sessions/:id/proxy-decisions/:role` | `SubmitProxyDecision(requestedWeek, …)`（`session`）。一時停止中も受け付ける | 進行役 |
| | `GET /sessions/:id/state` | （問い合わせ） | 役割に応じた投影 |
| 通知 | `GET /games/:id/events`（SSE） | — | ゲームに属する操作者 |
| 学習 | `GET /games/:id/{observation,review}`、`GET /games/:id/exports` | （問い合わせ。出力は要求時に `buildExport` で生成） | 観察は参加者・進行役・観察者、振り返りと出力は終了後 |
| 資格 | `POST /games/:id/credentials/revoke`、`POST …/reissue` | `RevokeCredential`、`ReissueCredential`（`game`） | 進行役 |
| 保持 | `GET /games/:id/retention`、`POST …/retry` | （問い合わせ。`retry` は保持の手続きへ） | 進行役 |
| 運用 | `GET /health`、`GET /ready` | — | なし。**B1 の実装は `/api/v1` の配下**（`/api/v1/health`、`/api/v1/ready`。OpenAPI の servers のとおり）。負荷分散のヘルスチェックのパスの設定が要る（[インフラストラクチャ](./architecture-infrastructure.md)） |

**B1 の実装で確定した、経路の補足（2026-11-14）。** (1) `SaveDecision` の `role` は本文に持たせず、**認証つきの `snapshot` で参加者の役割を引いてから** `saveDecision` を呼ぶ（認証が 2 回走る。別のトランザクション）。役割の無い操作者は 403。(2) `GET /sessions/:id/state` の `?role=`（他の役割の取得。AC2.1.2）は、自分の役割と違えば `game.forbidden`（HTTP では `app.unauthorized`）。(3) `POST /games` の応答は `versions` だけで、ゲームの ID は `Location`（`/api/v1/games/{id}/state`）、資格は `Set-Cookie`。参加の応答は `versions` だけで、`gameId` を含まない（**参加者が、参加後に `gameId` を知る手段が無い。未決事項** → **B5 Step 6 で解消**: 参加の応答に `gameId`、作成の応答に復帰コード `recoveryCode` を足した。「応答とスナップショット」を参照）。(4) 作成の入力は `finalWeek` と `demand` を必須とし、`retentionDays` は未指定で 90。(5) `UnassignRole`（`DELETE …/role`）は B1 に実装していない。

**B2 の契約テストで確定した、仕様の補足（2026-11-15）。** [契約テスト](./test-strategy.md)（`app` の test）が仕様と実装の不一致を見つけ、実装は変えず、**仕様（`contracts/openapi.yaml`）を実装に合わせた**（ADR-008 の「仕様が先」に照らすと後追い。人の確認待ち）。(1) **409 の problem に拡張メンバー**を持つ: 実装は `requestedWeek`・`currentWeek`・`role`・`latest`・`week`・`current` を返す。仕様に `ConflictProblem`・`ConflictProblemBody`・`DecisionEntry` を追加し、`saveDecision`・`commitWeek` の 409 に使う（どのメンバーがどちらの操作かは、仕様と `ProblemMapping.kt` が正本）。(2) **429（`app.rate_limited`）は、探針（`/health`・`/ready`）を除く全操作に、413（`request.too_large`、本文 64 KB 超）は変更系の全操作に、500 は問い合わせ系を含む全操作に宣言**する（HTTP の層の共通の守り。7 操作・4 操作・3 操作の宣言漏れを足した）。(3) **`CreateGameRequest` の範囲**を `minimum`・`maximum` で持つ（最終週 1〜50、需要 0〜1000、保持日数 1〜3650。範囲外は 422）。(4) **表示名は 1〜80 文字**（`minLength: 1`、`maxLength: 80`。「上限は未決」だった）。(5) **`GameState.sessionId` は `required`**（開始前は `null`）。(6) 参加コードの失敗（`game.invitation_invalid`）と、分類が Forbidden のドメインの誤り（`session.forbidden`・`game.forbidden`。HTTP では `app.unauthorized` に写る）の `code` の扱いは、`ProblemMapping.kt` が正本。範囲と表示名の長さを**仕様にも重複して持つ**ことの確認は人の判断。

beer-game2 の `POST /sessions/:id/start` は、`session` を対象にしていました。本書は、**開始が 2 つのストリームにまたがる**ため、ゲームの資源として `POST /games/:id/start` にします（beer-game2 からの変更。API の表を持つ他文書への影響として、呼び出し元で確認してください）。

### 入力の検証とエラーの写像

- ルートは、DTO（`kotlinx.serialization`）を、スマートコンストラクタで `Command` に変換します。誤りは**すべて集め**（`zipOrAccumulate`。[ガイド §3.4](../../reference/関数型プログラミングガイド_Kotlin編.md)）、`422` で、項目ごとの誤りを返します（[ユーザーストーリー](../../requirements/beer-game2/user_story.md) AC1.1.2、AC1.1.4）。本文の構文エラーは `400`。
- ドメインのエラーは、分類で HTTP の状態へ写します。**写像は 1 か所（`adapter-http`）の純粋関数**で、`when` の網羅で漏れをなくします。

| 分類（[ドメインモデル](./domain-model.md)） | HTTP | 備考 |
| :--- | :--- | :--- |
| `Forbidden` | 403 | 無効な資格と、権限の不足は、同じ形（`app.unauthorized`）で返す（列挙の防止）。**参加コードの不明・形式不正だけ**は、別の `code` `game.invitation_invalid`（同じ本文）。B1 の実装では、業務の権限不足（`game.forbidden`・`session.forbidden`）も `app.unauthorized` の本文にする（資格の失敗と区別しない）。招待コードの失効・期限切れ・不明は区別せず（B9）、同じ `game.invitation_invalid` を返す |
| `NotFound` | 404 | 存在を明かしてはならない対象は、`403` と同じ応答にする |
| `InvalidState` | 409 | 現在の状態を `detail` に示す。**受付終了（開始済み）後の参加は 409 `game.not_preparing`**（B1 の実装。AC1.2.2 が理由を示すため） |
| `Conflict` | 409 | `DecisionConflict`（`session.decision_conflict`）は、最新値と最後の保存者を本文に含める。`WeekAdvanced`（`session.week_advanced`）は、週が進んでいることを示す。`DecisionsChanged`（`session.decisions_changed`）は、現在の値と保存者を含める |
| `RuleViolation` | 422 | `StartConditionNotMet` は不足する役割を、`IncompleteDecisions` は不足する役割を示す |
| `ValidationError` | 422 | 複数の誤りを配列で返す |
| `AppFailure.IdempotencyKeyReused` | 409 | `app.idempotency_key_reused` |
| `AppFailure.RetryExhausted` | 503 | `app.retry_exhausted`。**`Retry-After` ヘッダーを付ける**。再試行の上限、または再構築のロックの待ちの上限を超えたとき |
| `AppFailure.Persistence` | 500 | `type` は持つ（`/problems/app.internal`）。利用者へは相関 ID だけを返す |
| `AppFailure.Unauthorized` | 403 | `app.unauthorized`。失効・期限切れ・不明を区別しない |
| `AppFailure.Invalid` | 422、400 | 項目ごとの誤り（下記）。構文エラーは 400。`code` は `validation.invalid_input` |
| HTTP の層の失敗（B1 の実装で追加） | 400、404、405、413、429、503 | `request.not_found`（経路なし）、`request.method_not_allowed`、`request.too_large`（本文 64 KB 超）、`app.rate_limited`（429、`Retry-After`）、`app.not_ready`（`/ready` が失敗したときの 503。**バックエンド自身の 503 は `type` を持つ規則に合わせ、problem+json（`/problems/app.not_ready`、`checks`）**）。名前は仮置き（HTTP の層の `code`） |

**アプリケーション層の失敗にも、安定した `code` を与えます。** 画面は、`type` が `/problems/app.retry_exhausted` のときだけ「もう一度お試しください」を出します（利用者が操作し直したら、新しい冪等キーを使う）。`type` を持たない 5xx（負荷分散装置の 503 など）、タイムアウト、切断は「結果が不明」として、**同じキーで再送**します（新しいキーで再送すると、ゲーム作成などが二重になる）。この区別を成り立たせるため、**バックエンド自身が返す 503 は、必ず `type` を持ちます**（[フロントエンド](./architecture-frontend.md)）。

`AppFailure` の型の正本は、上の「コマンド処理の流れ」のコードです。`DomainError` は `AppFailure.Domain` に包まれ、`ConcurrencyConflict` は再試行されるだけで利用者には返らない（上限に達すると `RetryExhausted`）ため、HTTP の写像はこの 7 種を `when` で網羅します。

`StaleVersion` は廃止しました。`CommitWeek` の判定の順は、「週が違う → `WeekAdvanced`」「週が同じで `basis` が現在の各役割の意思決定の版と違う → `DecisionsChanged`」です（共同担当が保存し直しただけで「すでに確定されています」と出る誤りを避けます）。

エラーの識別子は、**`code` を 1 つ**に決めます。小文字のドット区切り `<領域>.<名前>`（例: `session.week_advanced`、`session.decision_conflict`、`session.decisions_changed`、`game.invitation_invalid`、アプリ層は `app.retry_exhausted`、`app.idempotency_key_reused`、`app.unauthorized`、`app.internal`、`app.not_ready`、`app.rate_limited`、入力検証は `validation.invalid_input`、HTTP の層は `request.not_found`・`request.method_not_allowed`・`request.too_large`）です。失効・期限切れ・不明を区別する識別子（`invitation-expired` など）は**使いません**。どの資格の失敗かの文言は、画面が「自分が送った資格の種類」から選びます（[フロントエンド](./architecture-frontend.md)）。`problem+json` の `type` は `/problems/{code}`（相対 URI）、拡張メンバー `code` に同じ値を載せます。フロントエンドの辞書の鍵は `code` で、OpenAPI の契約にも載せます（[フロントエンド](./architecture-frontend.md)）。辞書の正本は [UI 設計](./ui-design.md) の「code 列つきの表」です。各 `DomainError` の `code` と分類は [ドメインモデル](./domain-model.md) が持ちます。

### 応答とスナップショット

コマンドの応答は `{ versions: { game, session } }` だけで、画面の表示は応答から作りません。**例外は、資格を発行・受け渡す操作の 2 つだけです**（B5 Step 6。[ADR-015](../../adr/beer-game-kotlin/015-credential-handover-and-session-revocation.md) の H3 案 A。ゲート 1 で決定済み）。

1. **応答の本文に、資格の値（復帰コード）を一度だけ載せる**。作成（`POST /games`）の応答は `recoveryCode`（進行役の復帰コード）、再発行（`POST /games/{id}/credentials/reissue`）の応答は `recoveryCode` と `expiresAt` を持つ。保存はダイジェストだけで、再表示しない。冪等な再送でも、同じ値を返す（冪等記録に暗号化して保存する。実測で確認）。ブラウザセッションの値は、これまでどおり `Set-Cookie`（`bg_session`）だけが運び、本文に含めない。ログ・イベントには、どの値も出さない。
2. **本文に、`versions` 以外の項目を持つ**。参加（`POST /participations/join`）の応答は `gameId`（判断項目 7）、復帰（`POST /participations/recover`）の応答は `gameId`・`kind`（`FACILITATOR` または `PARTICIPANT`）・`role`（担当の役割。未割り当てなら項目ごと付けない）を持つ。表示の内容（週の状況など）は含めない。

Cookie の寿命は、サーバー側の有効期限と同じ値にする（`bg_session` の `Max-Age` は `sessionTtl`、既定 24 時間。B1 は復帰資格の期限を流用していた。`bg_recovery` は `participantCredentialTtl`、既定 30 日で、復帰の経路だけに送る `Path=/api/v1/participations/recover`）。復帰の認可は、本文の `recoveryCode`、なければ Cookie `bg_recovery` の復帰資格（冪等記録の照合より前に検証）。画面は応答を受けたらすぐスナップショット（`GET state`）を取得し、`versions` に追いつくまで待って表示します。SSE は、他の人の変更の通知（と取得の補助）です。SSE が切れていても、自分の保存は画面に出ます。自動確定でも同じで、最後に保存した人の応答にも確定結果は含めず、週の進行はスナップショットで見ます。

## 自動確定

自動確定のための処理は、アプリケーション層にありません。[ドメインモデル](./domain-model.md) の `decideSession` が、`SaveDecision`、`SubmitProxyDecision`、`ResumeSession`、`SetCommitMode(AUTO)` のそれぞれで、`Active` かつ `AUTO` で 4 役割が揃っていれば `WeekCommitted`（最終週なら `SessionEnded` も）を同じ戻り値に含めます。`execute` は、イベントが 1 件でも 3 件でも、1 回の追記として扱います。

- **一時停止中**（`Paused`）の `SubmitProxyDecision`（進行役のみ）は受け付けますが、自動確定はしません。`SetCommitMode(AUTO)` を `Paused` 中に行った場合も確定せず、**再開時**に判定します（確定は、再開時の自動確定か手動確定）。参加者の `SaveDecision` は `Paused` で拒否します。
- `SubmitProxyDecision` は `requestedWeek` を持ち、週が違えば `WeekAdvanced`（`session.week_advanced`）です。意思決定の版は要求しませんが、版は従来どおり 1 増やします。

| 同時に起きること | 結果 |
| :--- | :--- |
| 最後の意思決定の保存と、進行役の手動の確定 | 先に追記した方が成立する。後の方は版の違反で再試行され、`decide` が `WeekAdvanced`（手動の確定の `requestedWeek` が進んだ週と違う）または意思決定の確定済みを検出する。確定は一度だけ |
| 共同担当の 2 人の同時の保存 | 先の方が成立する。後の方は再試行で再評価され、`DecisionConflict` と最新値を返す |
| 確定と一時停止 | 先に追記した方が成立する。後の方は再評価で、一時停止中の確定は `NotActive` になる |

## 通知（SSE）

- SSE は、**版の通知だけ**を送ります（`state-version`。ストリームの種別 `game` / `session` と版）。内容は運びません。beer-game2 の設計（ADR-006）を引き継ぎます。
- SSE は、**他の人の変更の通知**（と取得の補助）です。自分の保存の表示は、コマンドの応答の `versions` を受けて取得するスナップショットで行うため、SSE が切れていても出ます。
- **再生（`Last-Event-ID`）は行いません。** 接続の開始と再接続のたびに、クライアントが現在のスナップショットを取得します。
- 発信は、追記と**同じトランザクション**で、ポート `ChangeNotifier.publish`（ペイロードはゲーム ID、ストリームの種別、版だけ）を呼びます。PostgreSQL 版の実体は `pg_notify` です。コミットされたときだけ配信されるため、**ロールバックされた通知は出ません**。H2 版（ローカルのみ）は**プロセス内のイベント**で、単一のプロセスでだけ有効です（複数のプロセスには届かない）。

```plantuml
@startuml
title SSE の通知経路

participant "execute\n（tx）" as X
database "PostgreSQL" as DB
participant "ChangeNotifier.subscribe\n（PostgreSQL 版: 専用の接続・1 タスクに 1 本）" as L
participant "SharedFlow\n（タスク内）" as F
participant "SSE ルート\n（接続ごと）" as S
actor "ブラウザ" as B

X -> DB : ChangeNotifier.publish（PostgreSQL 版: pg_notify('game_events', {game, stream, version})）
X -> DB : COMMIT
DB -> L : 通知（コミット後。H2 版はプロセス内のイベント）
L -> F : emit(VersionNotice)
F -> S : gameId で絞り込んで collect
S -> B : event: state-version\ndata: {stream, version}
B -> S : （再取得）GET スナップショット
note over L : 数秒ごとの照合で、\nNOTIFY の欠落を補う
@enduml
```

| 項目 | 設計 |
| :--- | :--- |
| 受信 | PostgreSQL 版: `LISTEN` 専用の JDBC 接続を、1 タスクにつき 1 本、接続プールの外に持つ。受信ループは `Dispatchers.IO` 上のコルーチンで動かし、切断したら再接続して購読し直す。H2 版: プロセス内の `SharedFlow` を購読する（接続を持たない） |
| 配信 | 受信した通知を `MutableSharedFlow` へ流し、SSE の接続ごとに `gameId` で絞って送る（`Flow` は [ガイド §4.5](../../reference/関数型プログラミングガイド_Kotlin編.md)）。**遅い接続のために全体を止めない**（バッファの上限と、あふれた接続の切断） |
| 補完 | 購読中のゲームについて、数秒ごとに `projection_checkpoints` の版を照会し、通知より新しければ通知を出す。`NOTIFY` が失われても、また接続の切断中の追記があっても、収束する |
| 認可 | 接続時に、ゲームに属する操作者であることを検査する。資格の失効・期限切れは、定期の照合で検出して切断する |
| 心拍 | 定期的にコメント行を送り、負荷分散装置（アイドルタイムアウト 60 秒）に切られないようにする。間隔は 60 秒より短い値を実装開始時に決める |
| 終了 | プロセスの停止（SIGTERM）時は、接続を閉じる。クライアントは再接続し、スナップショットを取得して追いつく |
| 通知の遅延 | 追記のコミットから、SSE の送信までを測る（メトリクス） |

SSE は、Ktor のサーバープラグイン **`ktor-server-sse`** で実装します（[技術スタック](./tech-stack.md) で決定済み）。プラグインのバージョンごとの API の確認は、実装開始時にウォーキングスケルトンの負荷試験（SSE の接続数）と合わせて行い、使えない場合の逃げ道は、`respondTextWriter` で `text/event-stream` を直接書くことです。

## 保持削除

[ドメインモデル](./domain-model.md) の `RetentionSaga`（純粋な `decide` / `evolve`）と、[データモデル](./data-model.md) の `deletion_*` を、定期のタスク（`app` の retention モード）で駆動します。

1. 期限到来の検出（`retention_policies` と `deletion_runs`）。
2. `StartDeletion` を `decide` し、`deletion_runs` を更新する。
3. **削除用のロール**で、`DELETE FROM game_roots`、`deletion_runs` と `deletion_attempts` の削除、`deletion_receipts` への挿入を、1 トランザクションで行う。
4. 失敗なら `RecordFailure` を `decide` する（最大 5 回、指数バックオフ。続けて失敗したら通知する）。

保持のモードは、API のプロセスと別です。同じイメージの別の起動引数で、定期的に起動します（[インフラストラクチャ](./architecture-infrastructure.md)）。

## 観測性

[ガイド §7.7](../../reference/関数型プログラミングガイド_Kotlin編.md) の「監視は合成で足す」に従い、`execute` と問い合わせの関数を、**ラップして**ログとメトリクスを足します。ビジネスのコードを変えません。

```kotlin
fun Ports.observed(log: (LogRecord) -> Unit, emit: (Metric) -> Unit, now: () -> Instant): Ports = /* 各関数を observe でラップ */
```

| 項目 | 設計 |
| :--- | :--- |
| ログ | 構造化 JSON。`LogRecord` はデータクラスで、**項目として、資格・表示名・非公開の値を持たない**（型で除外する。秘匿の設定に頼らない）。相関 ID、操作、結果、ストリームの版、所要時間、ゲームの不透明な ID、**参加・復帰の要求だけが持つ接続元の鍵付き要約（`src`。窓の鍵と同じ値。生の接続元ではない。B5 Step 5）**を含む。出力は標準出力（コンテナのログドライバが収集）。ログの基盤は **SLF4J + Logback**（決定済み。[技術スタック](./tech-stack.md)）。アプリのログは `LogRecord` の JSON、Logback は枠組みのログ用 |
| 秘密の型 | 秘密の値は、`toString` が伏せ字になる `Secret<A>`（`value class`）で持つ。誤ってログや例外のメッセージへ出ても漏れない |
| エラー | 予期しないエラーは、スタックと相関 ID を含めて、必ず記録する。利用者へは、相関 ID だけを返す |
| メトリクス | 応答時間（操作・結果別）、エラー率、`ConcurrencyConflict` の件数と再試行の回数、`DecisionConflict`、確定の方式（手動 / 自動）、**再生したイベント数と再生の所要時間**（スナップショットの要否の判断材料）、投影の更新時間、SSE の接続数、通知の遅延、接続プールの使用状況、JVM のヒープと GC の停止時間、削除の経過時間。CloudWatch の Embedded Metric Format の JSON 行を標準出力へ出す（追加のサーバーを持たない。beer-game2 と同じ） |
| 追跡 | 相関 ID を、HTTP、コマンド（`correlationId`）、イベントの封筒、SSE の通知、ログに伝える。コルーチンをまたぐ伝播は、コルーチンのコンテキストで行う |
| ヘルスチェック | `GET /health`（生存）と `GET /ready`（`SELECT 1`、接続プールの取得、**通知の受信が生きていること**＝`ChangeNotifier.isAlive`。PostgreSQL 版は LISTEN の接続）。負荷分散には `/ready` を使う |
| 不変条件の監視 | `projection_checkpoints.projected_version` と `MAX(stream_version)` の不一致、週確定の重複、`credentials` と資格のイベントの不一致、**投影の整合**（`fold(evolve)` の結果と投影の行の一致。日次）を、定期の検査でメトリクスとアラートにする |

## セキュリティ

beer-game2 の設計を引き継ぎ、Kotlin 版での実現方法を加えます。

| 項目 | 設計 |
| :--- | :--- |
| 資格 | 256 ビットの乱数（`SecureRandom`）。保存はダイジェスト（鍵付き HMAC-SHA256。冪等キーの digest とは別の鍵で、部分の並びも違う）と**鍵の版**。**B5 Step 4 の実装**: 資格の値は `v<版>.<乱数>`（版の接頭辞）で、鍵は複数の版を同時に持つ（`CredentialKeyRing`。発行は現在の版、検証は値が示す版の鍵。旧版の鍵を設定に残す間、旧版の資格は期限まで有効。外すと 403）。設定は `CREDENTIAL_KEY`（現在の鍵）・`CREDENTIAL_KEY_VERSION`（既定 1）・`CREDENTIAL_KEY_PREVIOUS`（旧版の鍵。`版:Base64` のカンマ区切り。名前は提案で、Terraform の秘密の形は変えていない）。ブラウザセッションの値と復帰資格の値は別の乱数・別のダイジェスト。**本番では鍵の設定を必須にし、未設定なら起動に失敗する**（`AppConfig.load` が `Either` で全項目の誤りを集め、失敗なら終了する。[ガイド §3.4](../../reference/関数型プログラミングガイド_Kotlin編.md)） |
| 有効期限と失効 | 進行役の資格、復帰資格、観察用の招待、ブラウザセッションのすべてが、有効期限と失効を持つ。判定は純粋関数 `CredentialValidity.status(now)` |
| 認証と認可 | 認証は、Cookie の生の値から `Actor` を決める（`credentials` / `browser_sessions` を引く）。**B1 の実装では、Ktor のプラグインでなく `application` の `execute` の中（トランザクションの中）で行う**（ルートは生の資格を `RequestMeta.credential` に入れて渡す）。ブラウザセッションが有効（`browser_sessions` の行があり、未期限切れ。失効は行の削除）なときだけ成功し、不明・失効・期限切れ・鍵が外された版を区別しない（`app.unauthorized`）。**B5 Step 4 の実装: 復帰（`RecoverParticipation`）は `Auth.RECOVERY`**（提示した復帰資格が `credentials` で未失効・未期限切れであることが認可）。**冪等記録の照合より前に検証する**（`ANONYMOUS` で作ると、失効した復帰資格の再送に保存済みの新しいセッションが返る。ADR-004、ADR-015。HTTP への配線は Step 6）。**認可はドメインの `decide` が行う**（役割、共同担当、進行役、観察者は読み取りだけ）。ルートの認可の検査は、ゲームの一致までにとどめる |
| 入力 | DTO のスキーマと、スマートコンストラクタの範囲検査。本文のサイズ上限と数量の上限を設ける |
| レート制限 | 全体（接続元ごとの固定窓。プロセス内）に加え、**参加、復帰、観察用の招待の参加を専用に制限**する（総当たりの対策）。**B5 Step 5 の実装（参加と復帰。観察用の招待は B9）**: 窓は **DB**（`participation_attempts`。BD8 の案 B。複数のインスタンスで合算される）。数えるのは**認可の失敗**（不明な参加コード、無効な復帰資格）だけで、成功と形式が不正な本文は数えない。検査の前に 1 を足し（別のトランザクション）、上限を超えたら検査せずに 429（`app.rate_limited`、`Retry-After`）、認可の失敗でなければ 1 を戻す。接続元は TCP の接続元を正規化（IPv6 は /64）して**鍵付き要約**にし、生の IP は DB にもログにも残さない（ログの `src` は要約）。上限・窓は設定値（`ATTEMPT_MAX_FAILURES`・`ATTEMPT_WINDOW_SECONDS`。既定 10 回・10 分。未計測の仮置き）。窓を保存できないときは通さない（閉じる側に倒す）。実装は `AttemptLimit.kt`（application。ポート `AttemptStore`）と `JdbcAttemptStore`（adapter-persistence。H2 と PostgreSQL で同じ SQL） |
| ヘッダー | CSP、HSTS、`nosniff`、Referrer-Policy を、すべての応答に付ける（Ktor のプラグインまたは自前のインターセプタ）。CloudFront のレスポンスヘッダーポリシーとの二重化は許容する |
| 秘匿 | 表示名と資格は、イベント、ログ、出力、通知に含めない（NF-S14）。型（`Secret<A>`、`LogRecord`、イベントの DTO）で守る |
| データベースのロール | 用途別に分ける: **書き込み**（`events` は INSERT / SELECT のみ。投影と周辺ストアの書き込み）、**読み取り**（投影の SELECT）、**観察者の読み取り**（`game_overview`、`session_overview`、`week_team_totals` の SELECT だけ。`game_join_codes` は含まない）、**削除**（保持削除）、**所有者**（マイグレーションだけ）。生の認証情報は Secrets Manager から注入する。**ロールと GRANT は PostgreSQL の統合テストでだけ検証する。H2 版（ローカル）は単一の接続ユーザーで、ロールの分離・追記専用・プールの分離は守られない** |
| 依存関係 | CI で、依存関係の脆弱性と秘密情報を検査する（ツールは [インフラストラクチャ](./architecture-infrastructure.md) に記載） |

## ローカル開発（H2）と実行の選択

ユーザーの決定（2026-11-14）により、**開発機でのローカル開発（起動と動作確認）だけ**、H2 の PostgreSQL モードで動かせます（[ADR-014](../../adr/beer-game-kotlin/014-h2-for-local-development.md)、提案中）。Docker や PostgreSQL がなくても起動できることが目的で、**設計の検証や性能の計測には使いません**。統合テスト、受け入れ（Cucumber の `@api`）、CI、ステージング、本番は PostgreSQL 18 です。方言の差分と、H2 版で省略する制約の一覧は [データモデル](./data-model.md) が正本です。

**2 つのポートで、PostgreSQL 固有の機能を隠します。**

| PostgreSQL 固有の機能 | ポート | H2 版の実体 |
| :--- | :--- | :--- |
| アドバイザリロック（投影の再構築との直列化） | `ProjectionLock` | プロセス内の読み書きロック（単一プロセスのみ） |
| LISTEN/NOTIFY（SSE の版の通知） | `ChangeNotifier` | プロセス内のイベント（単一プロセスのみ） |

部分一意索引 `uq_idempotency_create`、DB ロールと GRANT（追記専用、`TRUNCATE` の拒否）、接続プールの分離、`jsonb` などは、ポートにせず、**PostgreSQL の統合テストでだけ検証**します。H2 版では、H2 で表せる形（通常の一意制約、アプリケーション側の検査）に置き換えるか、省略します。**省略した制約は、ローカルでは守られません。**

**実行の選択は、設定（プロファイル）で行います。**

| 設定 | 値 | 意味 |
| :--- | :--- | :--- |
| `DB_KIND` | `postgres`（既定）、`h2` | `app` がワイヤリングで、`EventStore` の接続、`ProjectionLock`、`ChangeNotifier`、マイグレーションの場所（共通 + 各方言）を選ぶ |
| `APP_ENV` | `local`、`test`、`staging`、`production` | 実行の環境。必須（未設定は起動の失敗） |

名前は提案です（環境変数の正本は [インフラストラクチャ](./architecture-infrastructure.md)）。

**本番・ステージングで H2 が選ばれないようにします（起動時の検査）。** `AppConfig.load` が、他の項目の検査と一緒に誤りを集めます（[ガイド §3.4](../../reference/関数型プログラミングガイド_Kotlin編.md)）。**許可リスト方式**で、`DB_KIND=h2` を許すのは `APP_ENV=local` のときだけです（`test`・`staging`・`production` と、未設定・未知の値は拒否）。拒否のときは `Left`（例 `ConfigError.H2NotAllowed(env)`）を返し、プロセスは**起動に失敗して終了**します。

```kotlin
/** 純粋な検証。H2 は APP_ENV=local のときだけ許す（拒否は起動の失敗） */
fun validateDbKind(env: AppEnv?, kind: DbKind): Either<ConfigError, DbKind> = when (kind) {
    DbKind.Postgres -> kind.right()
    DbKind.H2 -> if (env == AppEnv.Local) kind.right() else ConfigError.H2NotAllowed(env).left()
}
```

- 検査は、`AppConfig.load` の単体テスト（`APP_ENV` × `DB_KIND` の全組み合わせ）で守ります。
- 多層の防御として、ステージング・本番の配備の定義（インフラストラクチャ）では `DB_KIND=postgres` を固定し、本番のイメージには H2 のドライバを含めない案を検討します（[インフラストラクチャ](./architecture-infrastructure.md)、[技術スタック](./tech-stack.md)。H2 は `com.h2database:h2`、開発用の依存。導入は承認待ち）。
- 起動時に、選ばれた `DB_KIND` と `APP_ENV` をログに出します（H2 のときは警告のレベル）。

**単一プロセスの制約。** H2 版の `ProjectionLock` と `ChangeNotifier` は、1 つのプロセスの中でだけ有効です。複数のプロセス（API を 2 つ、API と `rebuild-projections` など）では、再構築との直列化も SSE の通知も保証しません。ローカルは 1 プロセスで使う前提です。

**乖離のリスクと対策。** ローカルで通っても、CI で落ちる乖離が起きえます。(a) **H2 でしか通らない記述を禁止**する（PostgreSQL の統合テストが正。H2 のために共通の DDL や SQL を曲げず、通らない文は方言ごとの場所へ分ける）。(b) **ポートの契約テストを両実装で実行**する（PostgreSQL 版は統合テスト、H2 版はユニットテスト）。(c) **受け入れ（Cucumber の `@api`）は PostgreSQL で実行**する。

**確認できた事実と、できなかった事実。** 2026-11-14 に H2 の公式ドキュメント（[features](https://h2database.com/html/features.html) の PostgreSQL 互換モード）を確認した範囲では、アドバイザリロック、LISTEN/NOTIFY、部分インデックス、ロールと GRANT、JSONB、SQLSTATE、分離レベルの差異は、**ドキュメントで確認できませんでした**。**B1 の Step 1・7 で実測して確定しました**（H2 2.5.252、`MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE`）。結果は [データモデル](./data-model.md) のローカル開発の方言の差分の表が正本です。要点: アドバイザリロック、`LISTEN`/`NOTIFY`、部分一意索引、`GRANT TRUNCATE` は動かない（上のポートと省略で置き換え）。`jsonb` は挙動が違う（書き込みは方言ごとに分ける）。共通のマイグレーション V001〜V005 は、H2 にそのまま適用できた（`${json_type}` のプレースホルダだけで方言を切り替え）。H2 専用のマイグレーションは不要。H2 での性能・分離レベルの動作の同一性は未確認です。

**B1 の実装で確定した、設定の補足。** `AppConfig` / `ServerConfig` は、誤りを集めて返し、`local` 以外では鍵（`CREDENTIAL_KEY`・`IDEMPOTENCY_KEY`・`RESPONSE_KEY`。Base64 の 32 バイトで、3 つは別の値）を必須にします。`DB_KIND` は未設定なら `postgres`、`h2` の大文字小文字は区別しません。`DB_KIND=postgres` でも JDBC の URL が `jdbc:h2:` なら、`local` 以外を拒否します。終了コードは 0・64・70・78（設定の誤りは 78）。環境変数の名前（鍵、`DB_URL`・`DB_USER`・`DB_PASSWORD`、`PORT`、`HOST`、`ALLOWED_ORIGINS`、`COMMAND_MAX_ATTEMPTS`、`MIGRATE_ON_START`）は B1 の提案で、[インフラストラクチャ](./architecture-infrastructure.md) の正本と未照合です。マイグレーションは、H2（local）の起動時に自動で適用し、PostgreSQL の `api` は適用しません（`migrate` モード）。`retention`・`rebuild-projections` のモードは B11・B12 で、未実装です。

## モジュール構成と依存の検査

```text
apps/beer-game-kotlin/
├── settings.gradle.kts
├── gradle/libs.versions.toml         （バージョンカタログ。版はここだけに書く）
├── domain/                           （純粋。Arrow Core のみ）
│   └── src/main/kotlin/.../{shared,game,session,retention,simulation,projection,disclosure}/
├── application/                      （Ports、execute、問い合わせ、再試行）
├── adapter-http/                     （Ktor のルート、検証、認証、SSE、エラーの写像）
│   └── src/main/kotlin/.../{routes,security,sse,problem}/
├── adapter-persistence/              （JDBC、EventStore、投影の SQL、EventCodec、ProjectionLock・ChangeNotifier の PostgreSQL 版と H2 版、マイグレーション）
│   └── src/main/resources/db/migration/  （Flyway の番号つきの SQL。**B1 で確定: `common/V001〜V005`、`postgres/V102`。B5 Step 5.5 で、`common/V007`・`V008` を足し、`postgres/` は 101＝冪等記録の索引、102＝DB ロールと GRANT に付け替えた**。006（保持）は B11 の予約。h2/ は作らない）
├── app/                              （main、AppConfig、ワイヤリング、起動のモード）
├── contracts/openapi.yaml            （API の契約。手書きの正本。フロントエンドの型の源）
├── ui/                               （フロントエンド。別のパッケージとして扱う。**B1 の実装の場所は `web/`**）
├── features/                         （日本語 Gherkin。B1 で追加。両処理系が参照する）
└── infra/                            （Terraform）
```

| 検査 | 内容 | 失敗時 |
| :--- | :--- | :--- |
| モジュールの依存 | `domain` は他のモジュールを参照できない（Gradle の依存宣言）。`application` は `adapter-*` を参照できない | ビルドが失敗 |
| 外部ライブラリの制限 | `domain` と `application` は、Ktor、JDBC、`kotlinx.serialization`、ログの基盤を依存に持たない。依存関係の宣言の検査で確認する | CI が失敗 |
| 関数型の規約 | `var` プロパティ、`!!`、`throw`、一般的な `catch`、`runBlocking`、`reduce`、`suspend` でない関数での時計・乱数・UUID の呼び出しの禁止（[ガイド §9.6](../../reference/関数型プログラミングガイド_Kotlin編.md) の PMD の XPath ルール、または detekt）。対象は `domain` と `application` | CI が失敗 |
| 静的解析 | detekt（複雑度、潜在的なバグ、例外の握りつぶし）、ktlint（整形。`.editorconfig` で調整。[ガイド §9.4](../../reference/関数型プログラミングガイド_Kotlin編.md)）。コンパイラの警告をエラーにする | CI が失敗 |
| 契約 | OpenAPI と実装の一致を、契約テストで確認する（[フロントエンド](./architecture-frontend.md)） | CI が失敗 |

ツールの版と、採用する Kotlin の版との互換性は、B1 で確認しました（2026-11-14）。**detekt 1.23.8 は JDK 25 で動きません**（`Execution failed for task ':domain:detekt'` / `java.lang.IllegalArgumentException: 25.0.2`。同梱の Kotlin コンパイラの `JavaVersion.parse`。既定の `--jvm-target` も 22 までしか受け付けない）。回避として `jvmTarget = "22"` を指定し、**JDK 22 以下で動かしたときだけ detekt を有効にします**（JDK 25 では無効にして警告）。CI は detekt を JDK 21 の専用ジョブで実行します。JDK 21 上では、Kotlin 2.4.21 のドメインとテストのコードの解析に成功し、違反は 0 件です。JDK 25 での代替（detekt 2 alpha、ktlint のカスタムルール、PMD の拡充）は B2 で判断します（B2 の受入条件「detekt が Kotlin 2.4 を解析できる」は、JDK 21 上では確認済み）。detekt 1.23.8 は、Kotlin 2.4 でビルドされたライブラリの `suspend` の呼び出しを検出できず、`RedundantSuspendModifier` が誤検知します（原因は未調査）。`@Suppress`・設定の緩和は使わず、ライブラリの suspend を呼ぶだけの関数を非 `suspend` のブロッキング関数にする、または `suspend` の関数型の値にして回避しました。`ForbiddenMethodCall`（`domain` の時計・乱数・UUID の禁止）は JDK 21 上で動きます（`mutableListOf` はインライン関数のため検出されず、可変コレクションの禁止は PMD の `NoMutableCollectionFactory` に任せる。B2）。厳格な適用（PMD の 14 ルール、fixture、ベースラインなし）は B2 です。**B2 の結果（2026-11-15）**: PMD 7.29.0 を `PmdCli`（`JavaExec`）で導入し、層ごとのルールセット 4 つ（`config/pmd/`）で全層の違反 0、fixture は期待 17 件と一致した。detekt は JDK 21 の専用ジョブで維持する（ユーザーの決定）。**アダプター（`NoThrow` ほか）・`main`・テストのルールの緩和は層単位で、外したルールの新規違反はその層で検出されない**（記録は [ADR-011](../../adr/beer-game-kotlin/011-strict-static-analysis.md)。承認待ち）。`adapter-persistence` の `throw`・可変コレクション・`var` をコードで直すかは人の判断。契約（OpenAPI と実装の一致）は、`app` の test の契約テスト（13 件）と、型の生成物の差分 0（`api:check`）で守る。

B1 の実装のパッケージは、設計のサブパッケージ（`{shared,game,session,…}`）に分けず、各モジュールの 1 つのパッケージにまとめています（`beergame.domain`、`beergame.application`、`beergame.http`、`beergame.persistence`）。ファイルの単位（`Game.kt`、`Session.kt`、`SimulateWeek.kt` など）で分けています。Flyway は `common/V001〜V005`、`postgres/V102`（部分一意索引 `uq_idempotency_create`）で、V101（DB ロールと GRANT）は B2 のために空けています。H2 専用のマイグレーション（201〜）は作りません。

## 品質属性への対応

| 品質属性 | 対応する設計 |
| :--- | :--- |
| 整合性 | ストリームの版の一意制約（ロックなし）、1 トランザクションでの追記・投影・周辺ストア・冪等記録、確定の一回性（`decide` と版）、自動確定を 1 回の追記で行う |
| 可用性・水平スケール | 状態を持たない API（状態はイベントの再生で毎回導く）。SSE は版の通知で、再接続時にスナップショットを取得して収束する |
| 性能 | 1 ストリームの再生は千件前後。スナップショットなしで足りるかを、再生時間のメトリクスと負荷試験で確認する（NFR-03） |
| 保守性 | モジュールの依存と関数型の規約を CI で守る。ルールは `decide` に集める。ルートを機能別に分ける |
| 観測性 | 合成による構造化ログとメトリクス、相関 ID、準備のヘルスチェック、不変条件の監視 |
| テスト容易性 | ドメインは純粋で、入力と出力だけでテストする。`Ports` を同じ型の関数に差し替え、インメモリの `EventStore` でアプリケーション層をテストする。永続化と並行性は実際の PostgreSQL で検証する（ローカルの H2 は検証に使わない。ポートの契約テストは両実装で実行する）（[ガイド 第 8 章](../../reference/関数型プログラミングガイド_Kotlin編.md)） |

## テスト戦略との対応

ドメインは、既知の系列の golden test と性質テスト（在庫・受注残が非負、計算と事実の一致、イベントの往復）で網羅します（[ガイド §8.3](../../reference/関数型プログラミングガイド_Kotlin編.md)）。コマンド処理は、インメモリの `EventStore` と固定の時計・ID で、ルートは Ktor のテスト用のホスト、永続化と並行性（共同担当の競合、自動確定と手動確定の競合、複数プロセス、`events` の追記専用の権限と否定テスト、永続化往復の同値性、観察者の接続プールの配線、連鎖削除の網羅）は、PostgreSQL 18 の実物で確認します（H2 は使いません）。`ProjectionLock` と `ChangeNotifier` の契約テストは、PostgreSQL 版（統合テスト）と H2 版（ユニットテスト）の両方で実行します。受け入れ（Cucumber の `@api`）と CI は PostgreSQL です。詳細は [テスト戦略](./test-strategy.md) を参照してください。

## beer-game2 からの変更

| # | beer-game2 | beer-game-kotlin | 理由 |
| :--- | :--- | :--- | :--- |
| 1 | Fastify、TypeScript。層は ESLint の `no-restricted-imports` で守る | Ktor、Kotlin。層は Gradle のモジュールと、関数型の規約の検査で守る | ユーザーの方針（Kotlin） |
| 2 | 集約を `SELECT ... FOR UPDATE` で読み、メソッドを呼び、版つきで更新 | 状態をイベントから再生し、`decide`、追記（版の一意制約）。**ロックなし**、競合は自動再試行 | ES + CQRS（[ガイド §7.3〜§7.6](../../reference/関数型プログラミングガイド_Kotlin編.md)） |
| 3 | ユースケースが集約のメソッドを呼ぶ | `execute` は `decide` / `evolve` を受け取る汎用の関数。ルールを持たない | ルールは純粋関数に |
| 4 | ポート（インターフェース）とアダプター | 関数の束（`typealias` と `data class`）。`suspend` が副作用の型 | [ガイド §7.2、§4.2](../../reference/関数型プログラミングガイド_Kotlin編.md) |
| 5 | 例外とエラー応答 | `Either` と `Raise`。境界でエラーを HTTP へ写す | [ガイド 第 3 章](../../reference/関数型プログラミングガイド_Kotlin編.md) |
| 6 | 入力は最初の誤りで止まる（想定） | 誤りを集めて返す | AC1.1.2、AC1.1.4 |
| 7 | 観察は役割別の結果を `SUM` | 観察は `week_team_totals`。別の接続プールと DB 権限で役割別の表に到達できない | 最小権限（BR-17） |
| 8 | 版つきの更新で、`WHERE version = $expected` | `If-Match` は `SaveDecision`（意思決定の版）だけ。`CommitWeek` は本文の `requestedWeek` と `basis`。追記の競合は、サーバーが再試行する | 共同担当の保存で確定が `StaleVersion` にならないように（H6） |
| 9 | 開始は `POST /sessions/:id/start` | `POST /games/:id/start`（2 ストリームへ追記） | 開始が 2 ストリームにまたがる |
| 10 | 通知は `LISTEN/NOTIFY`、再生なし | 同じ。通知に、ストリームの種別を加える | `game` と `session` の版が別 |
| 11 | ログの秘匿は、設定で除外 | `LogRecord` が秘匿の項目を持たない。`Secret<A>` | 型で守る（[ガイド §7.7](../../reference/関数型プログラミングガイド_Kotlin編.md)） |
| 12 | データベースのロールの分離は明記なし | 書き込み・読み取り・観察者・削除・所有者に分離。`events` は追記専用 | 追記専用と最小権限（[データモデル](./data-model.md)） |
| 13 | メトリクスは EMF（Pino のログ） | EMF を踏襲し、再生のイベント数・時間、再試行の回数、JVM のヒープと GC を加える | ES と JVM に固有の指標 |
| 14 | 設定の検証は、起動時にスキーマで | `AppConfig.load` が `Either` で全項目を集めて検証し、失敗なら起動しない | 純粋な検証（[ガイド §3.4](../../reference/関数型プログラミングガイド_Kotlin編.md)） |
| 15 | 出力は `export_packages` を保存 | 出力は要求時に `buildExport` で生成。表なし | 最終週の確定を出力の作成から切り離す（H3） |
| 16 | 冪等記録の照合の位置・保存の範囲は明記なし | 認可の前提検査の後に照合。`request_digest` に操作者の ID。保存は成功の応答だけ | 失効した旧担当者の再送で資格の生の値が返らないように（H4） |
| 17 | コマンドの応答に結果を含める（想定） | 応答は `versions` だけ。表示はスナップショットから | 更新の経路を 1 つに（H8） |
| 18 | エラーは `type` の識別子（`decision-conflict` など） | `code` を `<領域>.<名前>` に統一。`type` は `/problems/{code}` | 辞書の鍵を契約にする（H9） |
| 19 | 観察者は `game_overview` を含む表を読む（参加コードの扱いは明記なし） | `join_code` を `game_join_codes` に分け、観察者は `game_overview`・`session_overview`・`week_team_totals` の 3 表だけを読む | 観察者が参加コードから参加者として加われないように（M1。BR-17） |
| 20 | アプリ層の失敗の識別子は明記なし | `AppFailure` を単一の正本とし、`app.retry_exhausted`（503、`Retry-After`）・`app.idempotency_key_reused`・`app.unauthorized` に `code` を与える。`type` のない 5xx は「結果が不明」として同じキーで再送 | LB の 503 と区別でき、新しいキーでの二重作成を防ぐ（M7、M14） |
| 21 | 問い合わせの読み取りの一貫性は明記なし | 読み取り専用の REPEATABLE READ で、`projection_checkpoints` を同じトランザクションで読む | 行より新しい版を返さない（M15） |
| 22 | 投影の再構築の同時実行制御は未決 | コマンドは `pg_advisory_xact_lock_shared(game_id)`、再構築は排他の `pg_advisory_xact_lock(game_id)`。研修中は停止して再構築 | 「研修中は再構築しない」の制約を外す（M23。暫定） |
| 23 | 投影は `Projection<Row>` の `apply(row, event)` | `Event -> List<RowChange>`。他の投影を読まない | 再構築の順序に依存しない（M12） |
| 24 | Fastify の JSON 処理、node-pg-migrate、Pino、Fastify の SSE | kotlinx.serialization と `EventCodec`、Flyway（導入は承認待ち）、Logback、`ktor-server-sse`、手書きの OpenAPI | 未決の取り残しの解消（M16） |
| 25 | PostgreSQL 固有の機能（アドバイザリロック、`pg_notify`）を直接使う | ポート `ProjectionLock`・`ChangeNotifier` の裏に隠し、PostgreSQL 版と H2 版の 2 実装。契約テストは両実装で実行 | ローカル開発に H2 を使えるようにする（ユーザーの決定、2026-11-14。ADR-014） |
| 26 | データベースは PostgreSQL だけ。実行の選択の設定なし | `DB_KIND=postgres\|h2`（`APP_ENV` と合わせて）。H2 は `APP_ENV=local` のときだけ許し、それ以外は起動に失敗する | 本番・ステージングで H2 が選ばれないようにする |
| 27 | DB のロール、追記専用、部分一意索引は常に効く | PostgreSQL の統合テストでだけ検証。H2 版（ローカル）では省略し、守られない | H2 で確認できない機能の扱い |
| 28（以降は B1 の実装で変わった点。左は設計書の初稿） | `TransactionRunner` は `fun interface`（B1 の設計時） | 通常の `interface`（2026-11-14、B1） | 総称のメソッドは `fun interface` にできない（コンパイルエラーを確認） |
| 29 | `EventStore.append` は `Either<AppFailure, Unit>` | 追記後の封筒の列 `List<EventEnvelope<DomainEvent>>` を返す（2026-11-14、B1） | 同期投影が版つきの封筒を要する |
| 30 | `SideStores`（`project`・`writePeripheral`・`findIdempotent`・`saveIdempotent`）。`Ports` は 8 項目 | `ProjectionWriter`・`IdempotencyStore(find, save(now))`・`PeripheralStore` に分け、`Ports` は `Generators`・`Stores`・`lock`・`notifier`・`settings` の 5 項目に束ねる（2026-11-14、B1）。`PeripheralWrite` は設計どおりの純粋な導出 | detekt の引数の数の規則を、設定を緩めずに守る。期限切れの置き換えのため `save` が時刻を受け取る |
| 31 | 認証は、ルートで済み（Ktor のプラグイン）、`execute` へ `Actor` を渡す | `execute` の中（トランザクションの中、ロックの後）で認証し、再試行のたびに評価し直す。ルートは生の資格を渡す。参加だけは参加コードの照合を先に別の読み取りで行う（2026-11-14、B1） | ADR-004 の順序（認証 → 認可の前提検査 → 冪等記録の照合）を、同じトランザクションの中で守る |
| 32 | `CommandOutcome(versions)` | `CommandOutcome(gameId, versions, issued?)`。`Versions` は追記したストリームだけ（追記しなければ null）。HTTP が応答に載せるのは `versions` だけ（2026-11-14、B1） | 作成の再送が同じゲームと同じ資格を返す |
| 33 | 冪等記録の重複は、同じトランザクションで再照合する | `ConcurrencyConflict` に写し、`execute` の再試行の `find` で見つける。H2 版は挿入前の検索で `ConcurrencyConflict`（2026-11-14、B1） | PostgreSQL は、一意違反の後のトランザクションが使えない |
| 34 | 受付終了後の参加は、無効な参加コードと同じ 403 | 409 `game.not_preparing`。参加コードの不明・形式不正は 403 `game.invitation_invalid`（2026-11-14、B1） | AC1.2.2 は受付終了の理由を示す |
| 35 | `GET /games/:id/state` は無い | 進行役・参加者ごとの投影を返す入口を追加。`GET /games/:id/lobby` は B1 では進行役だけ（2026-11-14、B1） | 開始後に、画面が `sessionId` と状態を得る経路が要る |
| 36 | `/health`・`/ready` はルート直下を想定 | `/api/v1` の配下。`/ready` の 503 は problem+json（`app.not_ready`）。413（`request.too_large`）・429（`app.rate_limited`）を追加（2026-11-14、B1） | OpenAPI の servers に合わせる。バックエンド自身の 503 は `type` を持つ規則 |
| 37 | `Disclosure` は `domain` | `application`（2026-11-14、B1） | [ドメインモデル](./domain-model.md) 変更 #29 |
| 38 | detekt・PMD で関数型の規約を CI で検査（JDK 25 を想定） | detekt 1.23.8 は JDK 25 で動かず、JDK 21 の専用ジョブで実行する。厳格な適用（PMD）は B2（2026-11-14、B1） | detekt 1.23.8 が `jvmTarget` 22 までしか受け付けない |
| 39（以降は B2 の実装で変わった点。2026-11-15） | 409 の problem は `code`・`type` など標準のメンバーだけ（仕様に拡張メンバーが無い） | 実装が返す拡張メンバー（`requestedWeek`・`currentWeek`・`role`・`latest`・`week`・`current`）を仕様の `ConflictProblem` に持つ | 契約テストが不一致を検出。仕様を実装に合わせた（人の確認待ち） |
| 40 | 429・413・500 は、一部の操作にだけ宣言 | 429 は探針を除く全操作、413 は変更系の全操作、500 は問い合わせ系を含む全操作に宣言（HTTP の層の共通の守り） | 同上 |
| 41 | 作成の範囲（最終週・需要・保持日数）と表示名の長さは、説明文だけ・上限未決 | スキーマに `minimum`・`maximum`（1〜50、0〜1000、1〜3650）、表示名は 1〜80 文字。`GameState.sessionId` は `required` | 同上 |
| 42 | 関数型の規約は detekt・PMD で守る（PMD の導入は B2） | PMD を導入し、層ごとのルールセット 4 つ。アダプター・`main`・テストは層単位で緩和（承認待ち）。契約テストは `app` の test | B2 の Step 1・5 |
| 43（以降は B5 Step 4 の実装で変わった点。2026-11-15） | `AppSettings` は `credentialKeyVersion` と `credentialSecret`（鍵は 1 つ）、期限は `participantCredentialTtl` だけ | `credentialKeys: CredentialKeyRing`（版 → 鍵）、`sessionTtl`（ブラウザセッション）、`participantCredentialTtl`。資格の値は `v<版>.<乱数>`。`app` は `CredentialTtls`（`SESSION_TTL_HOURS`・`PARTICIPANT_CREDENTIAL_TTL_DAYS`）を設定から渡す | 判断項目 3（値の版の接頭辞）と 2（期限は設定値）。運営者との合意（R11）は未取得 |
| 44 | `CommandOutcome(gameId, versions, issued?)`。資格は 1 つの値がセッションと復帰を兼ねる | `CommandOutcome(gameId, versions, issued?, recovery?)`。`issued` はブラウザセッションの値、`recovery` は復帰資格の値（復帰コード）。冪等記録の本文の形式は `v2`（HTTP が応答に載せるのは、Step 6 まで `issued` の `Set-Cookie` と `versions` だけ） | H3 案 A。復帰コードの応答への載せ方は Step 6 |
| 45 | `Auth` は `ANONYMOUS`・`REQUIRED` | `RECOVERY` を追加。`PeripheralStore` に `authenticateRecovery` を追加。`CommandRequest` の資格の発行は、操作者から作る関数（復帰は認証まで主体が決まらない） | 復帰の認可は復帰資格の有効性（冪等記録の照合より前） |
| 46 | `PeripheralWrite.IssueCredentialRow`（資格とセッションを 1 行の導出で書く） | `IssueRecoveryRow`・`IssueSessionRow`・`ExtendRecoveryRow`・`RevokeSubject`。**`CredentialRevoked` のイベントには、必ず `RevokeSubject` が付く**（追記の共通の流れが、イベントから導く）。失効・再発行・復帰の内側の操作（`CredentialCommands.kt`。`internal`）は、公開の関数・HTTP への配線を Step 6 が行う | 資格の行の変更が、対応するイベントなしに起きない・イベントだけが書かれて行が残らない、のどちらも防ぐ |
| 48（B5 Step 6。2026-11-15） | 応答は `versions` だけ。失効・再発行・復帰の内側の操作は `internal` で、HTTP への配線は Step 6 | 作成の応答は `recoveryCode`、参加は `gameId`、再発行は `recoveryCode`・`expiresAt`、復帰は `gameId`・`kind`・`role?` を足す（`Reply`。ほかは `versions` だけ）。`revokeCredential`・`reissueCredential` は公開、復帰は `recover`（担当の役割を添える）を公開（`recoverParticipation` は `internal` のまま）。`pauseSession`・`resumeSession`・`submitProxyDecision`（`SessionControl.kt`）。開始後の `assignRole` は `applyAssign` が、準備中は `game` だけ、開始後は入れ替えとして `game` と `session` の 2 ストリームへ 1 回の追記で書く。`IssuedCredential.expiresAt`（再発行の応答に示す期限。冪等記録に含める。4 項目の形も読める）。`CommandRequest.recovery` は `(Actor, Instant)`（時刻を受け取る）。ブラウザセッションの Cookie の `Max-Age` は `sessionTtl`（B1・Step 4 は復帰資格の期限を流用。Step 4 の逸脱の解消）。`bg_recovery`（Path は復帰の経路だけ）を作成・参加で発行。ロビーの参加者に `replaced`（入れ替えで外された旧担当者）。**停止中の参加者の保存・確定を判定する順は「状態 → 権限」（ゲート 2）のため、資格のある参加者が停止中でないゲームを再開しようとすると 403 でなく 409 `session.not_paused`** | H3 案 A（ゲート 1）。**ゲート 6 で人が確認する**（API の形・認可の行列） |
| 47（B5 Step 5。2026-11-15） | 参加・復帰の専用のレート制限は、状態の共有が未決（BD8）。`AppSettings` は期限を 3 つのプロパティで持つ | **DB の窓**（`participation_attempts`）。`Stores` に `attempts: AttemptStore`、`AppSettings` に `attempts: AttemptPolicy`（上限・窓の長さ）、`RequestMeta` に `source: AttemptSource?`（正規化した接続元）。期限は `AppTtls`（`idempotency`・`session`・`participantCredential`）にまとめた（`AppSettings` の引数の数が detekt の上限に達したため。`idempotencyTtl` などのプロパティは同じ名前で読める）。`AppFailure.RateLimited(retryAfterSeconds)`（429 `app.rate_limited`）を追加。`app` は `Tuning`（資格の期限と窓）と `ATTEMPT_MAX_FAILURES`・`ATTEMPT_WINDOW_SECONDS` を設定から渡す。ログ（`LogRecord`）に、参加・復帰の要求だけが持つ `src`（接続元の鍵付き要約）を追加 | 判断項目 4 の案 A。**ゲート 5 で人が確認する** |

## 設計判断

[ADR](../../adr/beer-game2/) の判断のうち、ES + CQRS と Kotlin に関わるものは再評価して、ここに記録します。新しい ADR にする場合は、この節を元にします。

### BD1: 層の依存の守り方

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | Gradle のマルチモジュール + 関数型規約の検査 | `domain` の依存を、コンパイル時に機械的に強制できる。モジュールごとにテストとビルドが分かれる。設定の量が増える |
| B | 1 モジュール + パッケージ規約を検査ツールで守る | ビルドは単純。依存の違反が、ツールの設定の穴で通りうる |

トレードオフ: A は、モジュールの数だけ設定が要ります。中核の純粋性を守る価値が上回ると判断します。

### BD2: 依存の表し方

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | 関数の型の束（`typealias`、`data class`）。組み立ては `app` で手動 | ガイドの流儀。差し替えが関数で済み、DI のコンテナ（リフレクション）に依存しない。組み立てのコードが長くなる |
| B | インターフェースと DI のライブラリ | 依存の関係を宣言できる。ライブラリが増え、純粋関数の核とは相性がよくない |

### BD3: 永続化へのアクセス

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | JDBC と手書きの SQL（接続プール）。`withContext(Dispatchers.IO)` で包む | 追記の一意制約、`pg_notify`、アドバイザリロックを明示できる。beer-game2 の「ORM を使わない」を踏襲 |
| B | SQL のビルダー、または ORM（導入には承認が要る） | 型安全な SQL。イベントストアの追記の制御が間接になる |
| C | 非同期のドライバ（R2DBC） | ブロッキングを避けられる。ガイドの `Dispatchers.IO` の流儀から離れ、追加の依存と検証が要る |

### BD4: HTTP の枠組み

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用、ユーザーの方針）** | Ktor | コルーチン前提で、`suspend` の関数と相性がよい。SSE、認証、レート制限などのプラグインがある（個々の使用は実装開始時に確認） |
| B | http4k（ガイドの例） | `HttpHandler` が関数で、ガイドの流儀に近い。ユーザーが Ktor を指定 |

トレードオフ: ガイドは http4k の例で書かれています。Ktor では、ルートを**薄く**保ち、ルートの本体が「検証 → `execute` → 写像」の 3 つだけを呼ぶようにして、関数型の核と HTTP を分けます。

### BD5: イベントのシリアライズの置き場所

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | 永続化の DTO と、ドメインのイベントの相互変換（`EventCodec`） | `domain` がシリアライズの基盤に依存しない。イベントの形の変更（アップキャスト）を、永続化の層で閉じられる。変換のコードが増える（往復の性質テストで守る） |
| B | ドメインのイベントに注釈を付けて直接シリアライズ | 変換のコードが無い。ドメインが基盤に依存し、`schema_version` の管理がドメインに漏れる |

### BD6: 同期投影の競合

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | 追記 -> 投影の順。`game_overview` のように複数ストリームが更新する投影は、行の変更（`RowChange`）を、ロックの順序の規則（表名の辞書順、主キーの昇順）に従って適用する。明示的な `FOR UPDATE` は、今のイベント構成では実際には競合を防がない（`game` と `session` が別の列を更新し、UPDATE の暗黙の行ロックで足りる）。残すかは実装時に判断する | 追記で負けたコマンドは投影に触れない。投影の行のロックは短い。デッドロックは順序の規則で避ける |
| B | 投影を先に更新し、後で追記 | 追記に負けるとロールバックするだけだが、投影の行で無駄な待ちが生まれる |
| C | 投影を別のワーカーで非同期に更新 | 書き込みと読み取りを分離できる。結果整合で、通知の版が投影に追いつかない窓が生まれる（[データモデル](./data-model.md) の判断） |

### BD7: 競合の再試行の置き場所

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | `execute`（アプリケーション層）が、`ConcurrencyConflict` だけを再試行する | 再読み込みと `decide` の再評価が 1 か所。再試行の回数を計測できる |
| B | クライアントへ 409 を返して再送を促す | サーバーが単純。共同担当の同時入力で、利用者に見える失敗が増える（`DecisionConflict` と区別できない） |

### BD8: レート制限の状態の共有（beer-game2 から継続）

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| A | プロセス内の制限のみ | 単純。実効の上限がタスク数で増える |
| B | データベースの表に、窓ごとのカウンタを持つ | 実効の上限がタスク数で増えない。表の追加（データモデルの変更）と書き込みの負荷が生じる |
| C | 前段（WAF の rate-based ルールなど）で制限する | アプリに状態が要らない。独自ドメインと CloudFront の構成に依存する |

結論は未決とし、まず A（アプリ内）+ C（前段）の併用を提案します。B を採る場合は、[データモデル](./data-model.md) に表を追加します。

**B5 Step 5 の決定（2026-11-15。判断項目 4 の案 A。ゲート 5 で人が確認する）**: **参加・復帰の専用の制限だけ、案 B（DB の窓）で実装した**。全体の制限（接続元ごと 600 件/分）は、プロセス内のまま（案 A。負荷の保護で、数える対象が違う）。案 C（WAF）は B14 の判断で、併用できる。窓の表は `participation_attempts`（[データモデル](./data-model.md)「参加・復帰の失敗の窓」）。ALB の背後の接続元の取り方（信頼するホップの数）は B14 で決める。

### BD9: メトリクスの出力

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | EMF の JSON 行を、自前の小さな関数で標準出力へ | 依存を増やさない。beer-game2 と同じ。JVM の指標は標準の管理 API（`ManagementFactory`）から採る |
| B | Micrometer と CloudWatch への出力の実装 | JVM やプールの指標が自動で揃う。依存と設定が増える |

### BD10: 出力の生成の時機

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | 要求時に、全域の純粋関数 `buildExport` で `week_role_results` と設定から生成する。表は持たない | 最終週の確定が出力に依存しない。`Either` を返さない。要求のたびに計算する（大きい場合はキャッシュを将来検討） |
| B | 最終週の確定と同じトランザクションで `export_packages` へ同期投影 | 取得は速い。Should の出力の失敗が Must の確定を妨げ、「準備中」の表示も要る |

### BD11: 冪等記録の照合の位置と保存の範囲

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | 認可の前提検査の後に照合。digest に操作者の ID を含める。保存は成功の応答だけ | 失効した資格の再送は 403。失敗は再計算するため、状態の変化に追随する。失敗の再計算のコストは小さい |
| B | 照合を最初に行い、失敗も保存する | 同じ応答を返せる。失効した旧担当者に、保存済みの応答（資格の生の値）が返りうる |

### BD12: ローカル開発のデータベースと、PostgreSQL 固有機能の扱い

ユーザーの決定（2026-11-14）です。代替案は、決定の前提となる比較として記録します（[ADR-014](../../adr/beer-game-kotlin/014-h2-for-local-development.md)）。

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用、ユーザーの決定）** | ローカル開発だけ H2 の PostgreSQL モード。PostgreSQL 固有の機能（アドバイザリロック、LISTEN/NOTIFY）はポートの裏に隠して 2 実装。それ以外（部分一意索引、ロール、プール分離、`jsonb`）は PostgreSQL の統合テストでだけ検証し、H2 版では置き換えか省略 | Docker 不要で起動できる。ポートの契約テストを両実装で実行できる。ローカルでは省略した制約が守られず、CI で初めて落ちる乖離がありうる（対策は上の節） |
| B | ローカルも PostgreSQL（Docker で起動） | 本番と同じで乖離がない。Docker が必要で、起動が重い |
| C | H2 を統合テストにも使う | 速い。並行性・権限・部分一意索引・連鎖削除を検証できず、設計の検証が弱くなる（採用しない） |

トレードオフ: A は、開発の手軽さと引き換えに、ローカルで守られない制約を持ちます。H2 を検証に使わない規則と、PostgreSQL の統合テスト・CI・受け入れが正であることで、リスクを抑えます。

## 前提と見直しの条件

- スナップショットを導入する条件: 再生の所要時間が NFR-03（入力確定の 95 パーセンタイルを 1 秒以内）の予算を圧迫すると、**実測で分かった場合**だけ（[データモデル](./data-model.md)）。
- 非同期の投影へ移す条件: 同期投影のトランザクション時間が、書き込みの性能を圧迫する場合（[データモデル](./data-model.md)）。
- イベントの外部配信を設ける条件: 他のシステムとの連携、または非同期の処理が必要になった場合（beer-game2 と同じ）。
- 集約をさらに分ける条件: 1 つの `session` で、共同担当による入力の競合が、利用に影響する場合。

## 未決事項

**決定済み（取り残しの解消。M16）**: `DomainError.code` と分類は [ドメインモデル](./domain-model.md) が持つ。マイグレーションは Flyway（[技術スタック](./tech-stack.md) T4。**導入は承認待ち**）。ログは Logback。JSON は kotlinx.serialization と `EventCodec`（アップキャストは `adapter-persistence`）。OpenAPI は `contracts/openapi.yaml` の手書きを正本とする。SSE は `ktor-server-sse`。`POST /games/:id/start` への変更は、[フロントエンド](./architecture-frontend.md) の変更表に載せた。

**選定・確認が未決のもの**（「承認待ち」とは別）:

- 再構築のロック（`pg_advisory_xact_lock_shared` / 排他）の待ちの上限（`lock_timeout`）と、再構築中のコマンドの応答（短く待つか、すぐ 503 `app.retry_exhausted` を返すか）。研修中の停止・再構築・再開の手順は暫定で、人の確認が要る（M23）。
- `game_overview` の明示的な `FOR UPDATE` を残すか（BD6。ロックの順序の規則で足りるかを実装時に確認）。
- 再試行の上限（`ConcurrencyConflict`、40001、40P01）と、間隔（ジッター）の要否。競合の頻度を測って決める。
- 出力（`buildExport`）が大きい場合のキャッシュの要否（将来の検討）。
- レート制限の状態を共有する方法（BD8）。
- `ktor-server-sse`、レート制限、`CallId` の各プラグインの、採用する版での API の確認（実装開始時）。
- 通知の受信の接続（`LISTEN`）が、接続プーラーやプロキシを前段に置いた場合に動くか（本設計では置かない前提）。
- detekt と ktlint の、採用する Kotlin の版への対応の確認。**B1 の結果: ktlint 1.8.0 は動く。detekt 1.23.8 は JDK 25 で動かず、JDK 21 で動く。** JDK 25 での代替（PMD のカスタムルール、detekt の次の版の採用判断、ktlint のカスタムルール）は B2 で判断する。`RedundantSuspendModifier` の誤検知の原因は未調査。
- 資格のダイジェストの方式（HMAC の方式と鍵の導出）と、応答の暗号化の方式（ADR にする）。**B1 の実装は、資格が鍵付き HMAC-SHA256（鍵の版 1）、冪等記録の応答が AES-256-GCM。ADR は未作成。**

**B1 の実装で出た未決（2026-11-14。人の判断が要る）:**

- **参加者が、参加後に `gameId` を知る手段が無い。** 参加の応答は `versions` だけで、`gameId` も `Location` も返さない。参加者の画面が、ロビー・プレイの画面へ進めない。対応案は、参加の応答に `gameId`（と `Location`）を足すこと（バックエンドと仕様の変更。決めるまで、API は変えない）。
- **参加者向けのロビー**（`GET /games/:id/lobby` の参加者への開放）。投影の型に項目が無く、B1 は進行役だけ。
- **レート制限の値と範囲。** 接続元（`remoteHost`）ごとの固定窓、既定 600 件/分は**根拠なし（未計測）**の仮置き。プロセス内の状態（BD8 は未決。タスク数が増えれば実効の上限が増える）。ALB の背後では接続元が ALB になるが、`X-Forwarded-For` は信頼しない（信頼の範囲が未決）。参加・復帰の専用の制限は B5 Step 5 で実装した（DB の窓。上の「レート制限」と BD8）。
- **競合の再試行の上限 `maxAttempts`**は、B6 Step 5 の計測で 10 に決めた（[ADR-019](../../adr/beer-game-kotlin/019-retry-limit-and-serialization.md)。`AppSettings` に既定を置かず、`ServerConfig.DEFAULT_MAX_ATTEMPTS`（10）と `COMMAND_MAX_ATTEMPTS` で注入。実環境の値は未計測）。競合の再試行の遅延は無し。`lock_timeout` の既定 5 秒も仮置き。
- **Origin の検査。** 許可リスト（`ALLOWED_ORIGINS`。`local` 以外は必須）か、Host と同じ権限。Origin も Referer も無い要求は許す（ブラウザの外のクライアントのため）。拒否は `app.unauthorized`（専用の `code` は置かなかった）。Vite の開発用の中継は Host と Origin が一致しないため、`ALLOWED_ORIGINS` の指定が要る（開発手順書への反映は未実施）。
- **ログ。** `LogRecord` は項目の許可リスト（試験で固定）。`message` はコードの固定文だけ。予期しない例外はクラス名とスタックの各行を記録し、**メッセージは書かない**（接続文字列などが入りうる）。CloudWatch での収集、EMF のメトリクスは未確認・未実装。
- **`Persistence.open` のブロッキング**（PostgreSQL では最初の LISTEN まで最大 10 秒。起動時に 1 回）が、Ktor の起動で問題にならないかは未確認。
- **本番の ECS のイメージに H2 を含めない案**は未実施（H2 は `adapter-persistence` の `runtimeOnly`）。
- **実 DB の並行の検証。** `uq_idempotency_create`・`pk_idempotency_records` の同時の重複、`projection_checkpoints` と行の同時点の読み取り（REPEATABLE READ）は、直列の実行で確かめた範囲。**`LISTEN` の切断中の欠落を補う照合、冪等記録の掃除の定期タスク、投影の整合性の検査は未実装。**
- **ロビーの並び**（同じ時刻なら参加者 ID の順）と、参加コードの重複（`uq_game_join_codes_code`、12 文字の乱数なので再試行しない）。
- **`session_overview.week` が最終週 + 1 になる**（最終週が 50 未満のゲームが最終週を確定すると。[データモデル](./data-model.md) の未決事項）。
- 設定の上限（数量、遅延、本文のサイズ）の値と、検査の方法（beer-game2 から継続）。
- `events` に UPDATE / DELETE を与えないロールでも、連鎖削除が動くことの確認: **B2 で実測済み（動く）**。V101 でロール 4 つを作った（[データモデル](./data-model.md)）。アプリのコードを用途別のロール・接続に切り替える作業は未着手（B3 以降）。
- **B2 で出た未決（2026-11-15）**: 仕様の後追い修正 7 件の確認（上の「B2 の契約テストで確定した、仕様の補足」）。SSE の契約テストが未検査。問い合わせ系の 503（`app.retry_exhausted`）が起きうるか未確認。`adapter-persistence` の違反をコードで直すか（`ChangeNotifiers.kt` の `throw`、`JdbcEventStore.kt`・`JdbcTx.kt` の可変コレクション、`JdbcSupport.kt` の `var`）。
- **H2 の PostgreSQL モードで動く範囲の実測: B1 で完了**（Step 1・7。結果と配置は [データモデル](./data-model.md)）。残りは、H2 での性能・分離レベルの動作の同一性（未確認）。`com.h2database:h2` の導入の承認は、B1 の Gate 2 の記録を参照。
- `APP_ENV`・`DB_KIND` の名前と、ステージング・本番の配備での固定の方法、本番のイメージに H2 のドライバを含めない構成（[インフラストラクチャ](./architecture-infrastructure.md)、[技術スタック](./tech-stack.md) の担当と整合する）。

## 出典

- [ドメインモデル設計（Kotlin 版）](./domain-model.md)、[データモデル設計（Kotlin 版）](./data-model.md)、[非機能要件](./non-functional.md)、[運用要件](./operation.md)
- [beer-game2 のバックエンドアーキテクチャ](../beer-game2/architecture-backend.md)
- [ガイド 関数型プログラミング（Kotlin 編）](../../reference/関数型プログラミングガイド_Kotlin編.md) 第 3 章（型で表すエラー）、第 4 章（副作用の管理）、第 7 章（アーキテクチャ）、第 8 章（テスト戦略）、第 9 章（静的解析）
- [アーキテクチャ設計ガイド](../../reference/アーキテクチャ設計ガイド.md)
- [ADR-014 ローカル開発に H2（PostgreSQL モード）を使う](../../adr/beer-game-kotlin/014-h2-for-local-development.md)、[H2 公式ドキュメント（features）](https://h2database.com/html/features.html)（2026-11-14 確認）
- [ADR-003](../../adr/beer-game2/003-ports-and-adapters-with-lint.md)、[004](../../adr/beer-game2/004-separate-game-and-session-aggregates.md)、[005](../../adr/beer-game2/005-role-results-and-sql-read-models.md)、[006](../../adr/beer-game2/006-sse-version-only.md)、[007](../../adr/beer-game2/007-cascade-deletion-without-queues.md)、[008](../../adr/beer-game2/008-auto-commit-and-event-audit.md)、[009](../../adr/beer-game2/009-credential-key-versions.md)
