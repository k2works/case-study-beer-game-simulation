---
type: Design
title: "ドメインモデル設計 - ビールゲームシミュレーション（Scala 版）"
description: "Scala 版のドメインモデル。beer-game-kotlin の構造（2 ストリーム、decide / evolve、simulateWeek、投影、全イベント）を引き継ぎ、enum・case class・opaque type・Either・ValidatedNec で表す。Kotlin 版の設計判断 D1〜D11 との対応と、Scala 固有の判断 SD1〜SD7 を整理した正本。"
tags: [design]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-25T06:10:00Z }
---

# ドメインモデル設計 - ビールゲームシミュレーション（Scala 版）

## 概要

本書は、beer-game-scala のドメインモデルを定義します。[ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md) の決定により、**機能と振る舞いは beer-game2、設計の構造は [beer-game-kotlin のドメインモデル](../beer-game-kotlin/domain-model.md)、実装規約は [関数型プログラミングガイド（Scala 編）](../../reference/関数型プログラミングガイド_Scala編.md)（以下「ガイド」）を正本**として引き継ぎます。本書は、その構造を **Scala 3 の型**で表す方法と、Scala で変わる点だけを定めます。構造そのもの（2 ストリーム、ES + CQRS、イベントの意味）は変えません。

- 状態はイベントの列です。集約は `handle(state, command): Either[Error, List[Event]]` と `Events.apply(state, event): Evolution[State]` の 2 つの純粋関数で表します（ガイド §7.3、§7.4、§6.2）。Kotlin 版の `decide` / `evolve` に対応します。
- ADT（State・Command・Event・Error）は `enum` と `case class`、不正な値は `opaque type` とスマートコンストラクタで作れなくします。失敗は例外でなく `Either` で返し、独立な検証は `ValidatedNec` と `mapN` で全件集めます（ガイド第 3 章、§6.3）。
- 読み取りは、イベントを畳み込む純粋関数（投影）に分けます（CQRS、ガイド §7.5）。

入力は [要件定義](../../requirements/beer-game-ts/requirements_definition.md)（BR・FR・NFR）、[システムユースケース](../../requirements/beer-game-ts/system_usecase.md)、[ユーザーストーリー](../../requirements/beer-game-ts/user_story.md) です。**`docs/` を設計の正本**とします。実装コードはまだ存在しません（アプリの置き場は `apps/beer-game-scala` を予定）。

### 本書の位置づけと確認の範囲

- **本書で確認したこと**: 3 章の型とコードの断片（`Quantity`、`RoleMap`、`ValidatedNec` による設定の検証、`GameError.code`、Game 集約の `handle`、`Events.apply` と `Evolution`、再生）は、sbt 1.13.1（JetBrains Runtime 25.0.4.1）、Scala 3.7.4、cats-core 2.13.0、munit 1.3.6 で、`-Werror -Wunused:all -Wvalue-discard -Wnonunit-statement` と WartRemover 3.6.3（ガイド §9.4 の 13 個の Wart）を有効にしてコンパイルし、2 件のテスト（設定の誤りが 3 件集まる、付け替えが 2 イベントになる）が通ることを確認しました（2026-11-25）。状態に列挙子を 1 つ足すと、`Events.apply` の `match` で網羅の警告が出ること（`-Werror` で失敗する形）も確認しました。`var` と `head` が WartRemover に拒否されることも確認しました。**確認状況の正本は [技術スタックの確認状況の一覧](./tech-stack.md#確認状況の一覧)（K2〜K4）** です。
- **2026-11-25 のレビュー対応と再レビュー対応で書き直した部分は、再コンパイルしていません**: `Game.handle` の `AssignRole` の判定順（権限が先。L6）、`GameEvents.apply` の全面の書き直し（H2・再レビュー N-H1。許す組の表に合わせた）、`GameEvent` の 12 個の列挙子、`Evolution` を使う遷移の腕。いずれも AI の案で、承認を得ていない。**新しく書いた Scala のコードは、すべて型検査していません。** 再々レビューの対応（R-H3）でも、`GameData` と `GameEvents.apply` の条件つきの腕、`SessionEvents.apply` のスケッチ、`replacementEvents` を書き足しましたが、**再コンパイルしていません**（AI の案）。
- **確認状況の正本の規則（再レビュー N-H5。AI の案）**: 確認状況の一覧（[技術スタック](./tech-stack.md#確認状況の一覧)）が正です。一覧の根拠は実測の記録（[データモデル](./data-model.md) の「検証の結果」、[テスト戦略](./test-strategy.md) の「確認した事項」）で、**一覧を直すときは根拠も直します**。
- **確認していないこと**: Session 集約、`startGame`、`simulateWeek`、投影、`RetentionSaga` の Scala のコードは、**型検査していない設計のスケッチ**です。`Monoid`・`Functor` の法則のテストは書いていません。
- **引き継ぐだけで再検討していないこと**: 週次計算の規則（12 ステップ）、観察者の開示の規則、保持削除の細部、エラーコードの一覧、投影の購読表、ユビキタス言語の定義は、Kotlin 版の該当節を正本として参照します。Scala 版で変わるのは表現であり、API の契約（`code`、problem+json）は変えません。
- **Kotlin 版の実装の経緯（B1〜B13 の注記）は引き継ぎません。** 本書は、Kotlin 版の設計の現在の形を出発点とします。Kotlin 版の未決事項は、本書の未決事項に引き継ぎます（Rust 版と同じ扱い）。

### 設計の前提と原則

Kotlin 版の前提と原則をそのまま引き継ぎます（学習用シミュレーション、アカウントなし、決定論的な週次計算、役割別の情報制限、ルールは集約が持つ、ドメインは純粋、集約は最小の整合性の範囲、個人情報と秘密はイベントに入れない）。Scala 版で加わる原則は次のとおりです。

- **ドメインのプロジェクトは `cats-core` だけに依存する。** `cats-effect`・`doobie`・`http4s`・`circe` を持たない。時刻・乱数・識別子の生成・永続化は、コマンドの値として渡す（[技術スタック](./tech-stack.md) の ST3、ガイド §4.3、§1.3）。
- **`var`・`null`・`throw`・`return`・可変コレクション・`head` などの部分関数・`asInstanceOf` を使わない。** WartRemover で守る（ガイド §9.4）。遷移関数は全域で、例外を投げない。
- **新しい値を作って返す。** `case class` の `copy` と不変の `List`・`Map` だけを使い、共有可変状態は持たない（ガイド第 2 章）。

## 戦略的設計

境界付けられたコンテキストの分類、コンテキストマップ、ユビキタス言語は、[Kotlin 版](../beer-game-kotlin/domain-model.md) と同じです（中核: シミュレーション計算・進行、補完: 準備・学習ビュー、一般: 保持と削除）。コード上の名称は、Scala の命名規約（型は PascalCase、関数と値は camelCase）に合わせます。

| 概念（Kotlin 版） | Scala 版の名称 | 備考 |
| :--- | :--- | :--- |
| `GameState`、`SessionState` | `GameState`、`SessionState`（`enum`） | 状態の違いを列挙子で表す |
| `decideGame`、`evolveGame` | `Game.handle`、`Events.apply`（`GameEvents`・`SessionEvents` に分ける） | ガイド §7.3・§7.4 の `handle` と `Events.apply` に合わせる。**引数の順は、本書は `handle(state, command)`、ガイド §7.6 は `handle(command, state)` で違う**（Kotlin 版の `decide(state, command)` に合わせた。どちらかに揃えるかは B1 で決める） |
| `decideSession`、`evolveSession` | `Session.handle`、`SessionEvents.apply` | 同上 |
| `RoleMap<A>` | `RoleMap[A]` | 同じ |
| `StreamType`（`GAME`、`SESSION`） | `StreamType.Game`、`StreamType.Session` | |
| `Either<DomainError, …>` | `Either[GameError, …]` など | 標準の `Either`。Arrow は使わない |
| `zipOrAccumulate` | `ValidatedNec` と `mapN` | cats-core |

**パッケージ**: `beergame.domain`（値オブジェクト、`Command`・`Event`・`Error`、`handle`・`Events.apply`、`startGame`、`simulateWeek`、投影、`RetentionSaga`）。ほかの層は [バックエンドアーキテクチャ](./architecture-backend.md) の層の表のとおり。

```plantuml
@startuml
title コンテキストマップ（Scala 版。構造は Kotlin 版と同じ）

package "準備" {
  component "Game 集約\n（game ストリーム）\nGame.handle / GameEvents.apply" as GAME
}
package "進行" {
  component "Session 集約\n（session ストリーム）\nSession.handle / SessionEvents.apply" as SESS
}
package "計算" {
  component "simulateWeek\n（純粋関数）" as SIM
}
package "学習ビュー（CQRS の読み取り側）" {
  component "投影\nproject: Event => List[RowChange]" as LV
}
package "保持と削除" {
  component "RetentionSaga\n（プロセスマネージャー）" as RT
}

GAME --> SESS : startGame が両ストリームへ\n同一トランザクションで追記する
SESS --> SIM : 週確定で呼ぶ（handle の中）
LV ..> GAME : イベントを畳み込む
LV ..> SESS : イベントを畳み込む
RT ..> GAME : 期限到達の検出と\ngame_roots の削除
@enduml
```

## 戦術的設計

### 値オブジェクト

不変で、属性値が同じなら同じものとして扱います。**`opaque type`** とスマートコンストラクタ（`of`）で、生成時に検証し、不正な値が存在できないようにします（Kotlin の `value class` に対応し、ゼロコストで型を区別する。`GameId` と `ParticipantId` は別の `case class` にして取り違えを防ぐ）。ガイドは `opaque type` を扱っていませんが、`case class` と `copy` の範囲の機能であり、**本書の断片でコンパイルとテストを確認しました**（SD1）。

```scala
opaque type Quantity = Int

object Quantity:
  val DefaultMax = 1000
  def of(n: Int): Either[ValidationError, Quantity] =
    if n >= 0 && n <= DefaultMax then Right(n)
    else Left(ValidationError.QuantityOutOfRange(n, DefaultMax))
  extension (q: Quantity) def value: Int = q

enum Role:   // 上流から下流の順
  case Factory, Distributor, Wholesaler, Retailer

/** 4 役割すべてに値を持つ総称コンテナ。「4 役割が揃う」を型で表す */
final case class RoleMap[+A](factory: A, distributor: A, wholesaler: A, retailer: A):
  def apply(role: Role): A = role match
    case Role.Factory     => factory
    case Role.Distributor => distributor
    case Role.Wholesaler  => wholesaler
    case Role.Retailer    => retailer

final case class GameId(value: java.util.UUID)
final case class ParticipantId(value: java.util.UUID)
```

値オブジェクトの一覧（`Units`、`Week`、`Money`、`DemandSeries`、`Pipeline`、`InitialConditions`、`CostPolicy`、`DisclosurePolicy`、`CommitMode`、`SettingsKind`、`GameSettings`、`RoleState`、`RoleWeekResult`、`DisplayName`、`JoinCode`、`InvitationCode`、`CredentialValidity`、`CredentialSubject`、`RetentionPolicy`、`Actor`、`StreamVersion`、`DecisionVersion`）は、[Kotlin 版の表](../beer-game-kotlin/domain-model.md) の意味と制約を引き継ぎます。Scala 版での表現の違いは次のとおりです。

| Kotlin 版 | Scala 版 | 理由 |
| :--- | :--- | :--- |
| `@JvmInline value class` | `opaque type` + コンパニオンの `of`（検証が要らない識別子は `case class` の包み） | ゼロコストの型の区別。`opaque type` は定義の外から中身が見えない |
| `enum class`（`Role`、`CommitMode`） | `enum`（値だけ） | 同じ |
| `sealed interface`（`Actor`、`SettingsKind`、`CredentialSubject`） | データを持つ `enum` | 網羅検査はコンパイラが行う（`-Werror` で警告が失敗になる。ガイド §3.3） |
| `Money`（最小単位の整数） | `Money` は `Long`（最小単位）の `opaque type`（SD7） | 在庫単価・累積費用が `Int` を超えないことを保証しにくい |
| `Quantity`（0〜1000）と `Units`（上限なし） | `Quantity` は `Int` の `opaque type`、`Units` は `Long` の `opaque type`（SD7） | Kotlin 版の区別を維持する |
| `UUID`、`Instant` | `java.util.UUID`、`java.time.Instant` | JVM の標準。時刻はコマンドの値として渡し、`now` を呼ばない |
| `data class` の `copy` | `case class` の `copy` | 同じ |

#### 検証の誤りと業務ルールの失敗

入力の形の誤りは `ValidationError` として、境界でコマンドを作るときに**すべて集めて**返します。状態に照らした業務ルール違反は、集約ごとのエラー（`GameError`・`SessionError`）として、`handle` が 1 件返します（Kotlin 版と同じ分け方）。

Kotlin 版の `zipOrAccumulate` に当たるものは、cats-core の **`ValidatedNec` と `mapN`** です（ガイド §6.3）。誤りは `NonEmptyChain` に集まり、失敗しているなら誤りが 1 つ以上あることを型が保証します（Rust 版の `Vec` と違い、「誤りがあれば必ず 1 件以上」を型で表せます）。

```scala
enum ValidationError:
  case QuantityOutOfRange(actual: Int, max: Int)
  case FinalWeekOutOfRange(actual: Int)

final case class RawSettings(finalWeek: Int, demand: List[Int])
final case class GameSettings(finalWeek: Int, demand: List[Quantity])

object GameSettings:
  private def week(n: Int): ValidatedNec[ValidationError, Int] =
    if n >= 1 && n <= 50 then n.validNec else ValidationError.FinalWeekOutOfRange(n).invalidNec
  private def quantity(n: Int): ValidatedNec[ValidationError, Quantity] =
    Quantity.of(n).toValidatedNec
  def of(raw: RawSettings): ValidatedNec[ValidationError, GameSettings] =
    (week(raw.finalWeek), raw.demand.traverse(quantity)).mapN(GameSettings.apply)
```

これは、設定の誤りを全件返す受入条件（AC1.1.2、AC1.1.4）を満たす形です。上のコードは、範囲外の週と範囲外の需要 2 件で、誤り 3 件を返すテストが通ることを確認しました。`Either` の `for` は最初の誤りで止まるため、**独立な検証には使いません**（ガイド §6.3、§10.2）。

### エラーの分類と `code`

分類（`Forbidden`・`NotFound`・`InvalidState`・`Conflict`・`RuleViolation`）、`code` の書式（小文字のドット区切り `<領域>.<名前>`）、`code` の一覧は、**API の契約**であり、[Kotlin 版](../beer-game-kotlin/domain-model.md) の値を変えません。HTTP への写像と problem+json の `type` が変わらないため、フロントエンドと E2E はそのまま使えます。

```scala
enum ErrorCategory:
  case Forbidden, NotFound, InvalidState, Conflict, RuleViolation

enum GameError:
  case AlreadyCreated, NotPreparing, Forbidden
  case ParticipantNotFound(id: ParticipantId)
  // … Kotlin 版の一覧の残りも同じ形で足す

  def code: String = this match
    case AlreadyCreated         => "game.already_created"
    case NotPreparing           => "game.not_preparing"
    case Forbidden              => "game.forbidden"
    case ParticipantNotFound(_) => "game.participant_not_found"
```

`code` と `category` を `match` の網羅で書くことで、**列挙子を足したときに付け忘れが `-Werror` でコンパイルエラーになります**（Kotlin 版の「`DomainErrorCodesSpec` が一覧を固定する」に加えた、型による守り。ガイド §3.3）。**業務の失敗は `Either` で返し、`IO` の失敗（`IO.raiseError`）に使いません**（ガイド ADR-050。SD2）。

### 共通の型

イベントの封筒（`EventEnvelope[E]`）は、Kotlin 版と同じ項目（イベント ID、ゲーム ID、ストリーム種別、ストリームの版、スキーマ版、操作者の参照、相関 ID、コマンド ID、発生時刻、ペイロード）を持つ `case class` にします。コマンドは、`actor`（`Actor`）と `at`（時刻）を全コマンドが持ちます。`handle` は時計を持たず、`at` を使います。

### Game 集約（準備）

ストリームは `game`。責務と不変条件は Kotlin 版の表（設定の妥当性、作成の一回性、参加の受付、役割の割り当て、開始条件、観察用の招待、資格の有効性、設定の固定、役割の入れ替え、権限）を引き継ぎます。

#### State・Event・Command

```scala
/** 参加者・資格・招待・観察者。Kotlin 版の `GameData` に当たる（設定などは省略）。再々レビュー R-H3 で、状態の条件を表せる形に広げた */
final case class GameData(
    gameId: GameId,
    participants: Map[ParticipantId, Option[Role]],
    credentials: Map[CredentialSubject, CredentialValidity],   // CredentialValidity(expiresAt, revoked)
    invitations: Map[InvitationId, InvitationEntry],            // InvitationEntry(expiresAt, revoked)
    observers: Map[ObserverId, InvitationId]
)

enum GameState:
  case NotCreated
  case Preparing(data: GameData)
  case Started(data: GameData)

enum GameEvent:   // EV-G01〜G12 の 12 個。ペイロードは簡略化（条件に使う項目だけ。実際は Kotlin 版の表のとおり）
  case GameCreated(gameId: GameId, facilitatorCredentialExpiresAt: Instant)                       // EV-G01。進行役の資格を発行する
  case ParticipantJoined(participantId: ParticipantId, credentialExpiresAt: Instant)              // EV-G02
  case RoleAssigned(participantId: ParticipantId, role: Role)                                     // EV-G03。準備中の割り当てと、開始後の入れ替えの新担当者
  case RoleUnassigned(participantId: ParticipantId, role: Role)                                   // EV-G04
  case ObserverInvited(invitationId: InvitationId, expiresAt: Instant)                            // EV-G05
  case ObserverInvitationRevoked(invitationId: InvitationId)                                      // EV-G06
  case ObserverJoined(observerId: ObserverId, invitationId: InvitationId, credentialExpiresAt: Instant)   // EV-G07
  case CredentialRevoked(subject: CredentialSubject)                                              // EV-G08。入れ替えの自動失効にも使う（未失効の旧担当者にだけ。R-H3）
  case CredentialReissued(subject: CredentialSubject, expiresAt: Instant)                         // EV-G09
  case ParticipationRecovered(subject: CredentialSubject, credentialExpiresAt: Instant)           // EV-G10
  case GameStarted(gameId: GameId)                                                                // EV-G11
  case ParticipantReplaced(participantId: ParticipantId, role: Role, replacedBy: ParticipantId)   // EV-G12。開始後の入れ替え

enum GameCommand:
  case CreateGame(actor: Actor, gameId: GameId, facilitatorCredentialExpiresAt: Instant)
  case AssignRole(actor: Actor, participantId: ParticipantId, role: Role)
  // … JoinGame、UnassignRole、InviteObserver、RevokeCredential など（実際は at も持つ）
```

`GameState` は**版を持ちません**。ストリームの版は、永続化の層が `(state, version)` として持ちます（SD2。ガイド §7.6 の `Versioned`）。

#### handle と Events.apply

```scala
object Game:
  /** 作成前（NotCreated）は、誰も進行役ではない。権限の判定に使う（L6） */
  private def isFacilitator(state: GameState, actor: Actor): Boolean = state match
    case GameState.NotCreated         => false
    case GameState.Preparing(d)       => actor == Actor.Facilitator(d.gameId)
    case GameState.Started(d)         => actor == Actor.Facilitator(d.gameId)

  def handle(state: GameState, command: GameCommand): Either[GameError, List[GameEvent]] =
    command match
      case GameCommand.CreateGame(actor, gameId, expiresAt) =>
        for
          _ <- Either.cond(state == GameState.NotCreated, (), GameError.AlreadyCreated)
          _ <- Either.cond(actor == Actor.Anonymous, (), GameError.Forbidden)
        yield List(GameEvent.GameCreated(gameId, expiresAt))
      case GameCommand.AssignRole(actor, pid, role) =>
        // 判定順: 権限 → 準備中か → 参加者の存在（L6。権限のない人に状態を知らせない。Kotlin 版の原則）
        for
          _       <- Either.cond(isFacilitator(state, actor), (), GameError.Forbidden)
          data    <- state match
                       case GameState.Preparing(d) => Right(d)
                       case _                      => Left(GameError.NotPreparing)   // 開始後は assignRoleAfterStart（下記）
          current <- data.participants.get(pid).toRight(GameError.ParticipantNotFound(pid))
        yield current match
          case Some(r) if r == role => Nil                                        // 変化なし。履歴に足さない
          case None                 => List(GameEvent.RoleAssigned(pid, role))
          case Some(old)            => List(GameEvent.RoleUnassigned(pid, old),   // 付け替え = 2 イベント（D9）
                                            GameEvent.RoleAssigned(pid, role))

/** 遷移は全域。handle が作らない列は Ignored で返し、再生側が検知する */
enum Evolution[+S]:
  case Applied(state: S)
  case Ignored(state: S)

object GameEvents:
  // 条件を満たさない組は None（= Ignored）。条件は Kotlin 版の GameData の revoked・reissued・recovered・invited・
  // invitationRevoked・observerJoined・withRole が null を返す条件と同じ（Credential.kt・InvitationEntry.kt・Game.kt を読んだ。R-H3）
  private def withRole(d: GameData, p: ParticipantId, r: Option[Role]): Option[GameData] =
    d.participants.get(p).map(_ => d.copy(participants = d.participants.updated(p, r)))            // 未知の参加者は変えない
  private def revoked(d: GameData, s: CredentialSubject): Option[GameData] =
    d.credentials.get(s).filter(!_.revoked)                                                       // 未知の主体と失効済みは変えない
      .map(v => d.copy(credentials = d.credentials.updated(s, v.copy(revoked = true))))
  private def reissued(d: GameData, s: CredentialSubject, at: Instant): Option[GameData] =
    d.credentials.get(s).filter(_.revoked)                                                        // 未知の主体と失効していない資格は変えない
      .map(_ => d.copy(credentials = d.credentials.updated(s, CredentialValidity(at, revoked = false))))
  private def recovered(d: GameData, s: CredentialSubject, at: Instant): Option[GameData] =
    d.credentials.get(s).filter(!_.revoked)                                                       // 未知の主体と失効済みは変えない
      .map(v => d.copy(credentials = d.credentials.updated(s, v.copy(expiresAt = at))))
  private def invited(d: GameData, i: InvitationId, at: Instant): Option[GameData] =
    Option.when(!d.invitations.contains(i))(                                                      // 既知の招待は変えない
      d.copy(invitations = d.invitations.updated(i, InvitationEntry(at, revoked = false))))
  private def invitationRevoked(d: GameData, i: InvitationId): Option[GameData] =
    d.invitations.get(i).filter(!_.revoked)                                                       // 未知の招待と失効済みは変えない
      .map(e => d.copy(invitations = d.invitations.updated(i, e.copy(revoked = true))))
  private def observerJoined(d: GameData, o: ObserverId, i: InvitationId, at: Instant): Option[GameData] =
    Option.when(d.invitations.contains(i) && !d.observers.contains(o))(                           // 未知の招待と参加済みは変えない
      d.copy(
        observers = d.observers.updated(o, i),
        credentials = d.credentials.updated(CredentialSubject.Observer(o), CredentialValidity(at, revoked = false))))

  /** Preparing・Started の両方で、データを更新する。条件を満たさなければ Ignored。NotCreated は Ignored */
  private def update(s: GameState)(f: GameData => Option[GameData]): Evolution[GameState] = s match
    case GameState.Preparing(d) => f(d).fold(Evolution.Ignored(s))(n => Evolution.Applied(GameState.Preparing(n)))
    case GameState.Started(d)   => f(d).fold(Evolution.Ignored(s))(n => Evolution.Applied(GameState.Started(n)))
    case GameState.NotCreated   => Evolution.Ignored(s)

  def apply(state: GameState, event: GameEvent): Evolution[GameState] =
    (state, event) match
      // 腕は、下の「遷移の許す組の表」（規範）の ○ の組だけを書く。× の組は最後の腕の Ignored になる
      case (GameState.NotCreated, GameEvent.GameCreated(g, at)) =>
        Evolution.Applied(GameState.Preparing(GameData(g, Map.empty,
          Map(CredentialSubject.Facilitator(g) -> CredentialValidity(at, revoked = false)), Map.empty, Map.empty)))
      case (GameState.Preparing(d), GameEvent.ParticipantJoined(p, at)) if !d.participants.contains(p) =>   // 同じ参加者の 2 回目は Ignored
        Evolution.Applied(GameState.Preparing(d.copy(
          participants = d.participants.updated(p, None),
          credentials = d.credentials.updated(CredentialSubject.Participant(p), CredentialValidity(at, revoked = false)))))
      case (s @ GameState.Preparing(_), GameEvent.RoleAssigned(p, r))   => update(s)(withRole(_, p, Some(r)))   // 未知の参加者は Ignored
      case (s @ GameState.Preparing(_), GameEvent.RoleUnassigned(p, _)) => update(s)(withRole(_, p, None))
      case (GameState.Preparing(d), GameEvent.GameStarted(_)) =>
        Evolution.Applied(GameState.Started(d))
      // 開始後の役割の入れ替え（H2。Kotlin 版の変更表 38 に倣う）。Started の自己遷移として受ける。未知の参加者は Ignored
      case (s @ GameState.Started(_), GameEvent.RoleAssigned(p, r))           => update(s)(withRole(_, p, Some(r)))   // 入れ替えの新担当者
      case (s @ GameState.Started(_), GameEvent.ParticipantReplaced(p, _, _)) => update(s)(withRole(_, p, None))      // 旧担当者の役割を外す。行は消さない
      // 観察者の招待・参加・招待の取り消し、資格の失効・再発行、復帰は、準備中・開始後の両方で自己遷移。条件つき（R-H3。条件なしの Applied にしない）
      case (s @ (GameState.Preparing(_) | GameState.Started(_)), GameEvent.ObserverInvited(i, at))           => update(s)(invited(_, i, at))
      case (s @ (GameState.Preparing(_) | GameState.Started(_)), GameEvent.ObserverInvitationRevoked(i))     => update(s)(invitationRevoked(_, i))
      case (s @ (GameState.Preparing(_) | GameState.Started(_)), GameEvent.ObserverJoined(o, i, at))         => update(s)(observerJoined(_, o, i, at))
      case (s @ (GameState.Preparing(_) | GameState.Started(_)), GameEvent.CredentialRevoked(sub))           => update(s)(revoked(_, sub))
      case (s @ (GameState.Preparing(_) | GameState.Started(_)), GameEvent.CredentialReissued(sub, at))      => update(s)(reissued(_, sub, at))
      case (s @ (GameState.Preparing(_) | GameState.Started(_)), GameEvent.ParticipationRecovered(sub, at))  => update(s)(recovered(_, sub, at))
      case (s @ (GameState.NotCreated | GameState.Preparing(_) | GameState.Started(_)), _) =>
        Evolution.Ignored(s)

  def replay(initial: GameState, events: List[GameEvent]): (GameState, Int) =
    events.foldLeft((initial, 0)) { case ((s, ignored), e) =>
      apply(s, e) match
        case Evolution.Applied(n) => (n, ignored)
        case Evolution.Ignored(n) => (n, ignored + 1)
    }
```

（上のコードの `GameEvents` は、検証した断片では `Events` の名前です。集約ごとに分けるため、本書では `GameEvents` と書きます。）

最後の腕は、**状態の列挙子だけを列挙して**、イベントを `_` で受けます。状態を足すと、この `match` が網羅の警告になり、`-Werror` でビルドが止まります（**本書の断片で、状態を 1 つ足して警告を確認しました**）。イベントを足したときは、有効な組の追加を忘れても `Ignored` になるため、**性質テストで「`handle` が作る列は `Ignored` にならない」を守ります**（生成器は表からでなく**コマンドから**作る。下の「表の使い方」と R-H4。ガイド §7.3 の「許す組を足し忘れても、コンパイラは止めない」と同じ注意。Kotlin 版・Rust 版と同じ方針）。再生は `foldLeft` で、`Ignored` の件数を再生側が受け取ります（ガイド §7.4、§6.1）。

#### 遷移の許す組の表（規範。再レビュー N-H1。AI の案、承認を得ていない）

**「どのイベントを、どの状態が受けるか」を決めるのは、次の 2 つの表（EV-G01〜G12 × `game` の状態、EV-S01〜S10 × `session` の状態）です。これが規範**で、`GameEvents.apply`・`SessionEvents.apply` の `match`、状態遷移図、状態遷移テストは、**この表から導きます**。ただし、**「`handle` が作る列は `Ignored` にならない」性質テストの生成器は、表から作りません**（表から列を作ると、表と `apply` が一致することしか確かめられず、表そのものの漏れを見逃す。前回は `Started` のスケッチが図より狭く、観察者の招待・資格の再発行・復帰が `Ignored` になっていた。再々レビュー R-H4）。生成器は**コマンドから**作り、表は照合する側に回します（下の「表の使い方」）。止める設計（H3）では、許す組の漏れがそのまま研修中の停止（P1）になります。

表は、Kotlin 版の `evolveGame`・`evolveSession`（`Game.kt`・`SessionEvolve.kt`）と、Kotlin 版の状態遷移図（`domain-model.md` の「game ストリームの状態」「session ストリームの状態」）を**読んで**書きました。次の 2 点が Kotlin 版と違います。(1) Kotlin 版の `evolve` は、`handle` が作らない列を「状態を変えずに返す」だけで、Scala 版は同じ組を `Ignored` にします（検知が目的）。(2) Kotlin 版の `evolveSession` は、`DecisionSaved`・`WeekCommitted` などを `Paused` でも適用しますが、`handle` は `Paused` で作らないため、**Scala 版の表は、`handle`・`startGame`・`assignRoleAfterStart` が作る組だけを ○ にします**（`Paused` の `DecisionSaved`・`WeekCommitted`・`SessionEnded` は `Ignored`。止める設計では、これらが作らない列は不具合）。条件つきの ○ の条件は、Kotlin 版のコード（`Game.kt` の `GameData.withRole`、`Credential.kt` の `revoked`・`reissued`・`recovered`、`InvitationEntry.kt` の `invited`・`invitationRevoked`・`observerJoined`、`SessionEvolve.kt`、`Session.kt` の `withHolderReplaced`）を再々レビューの対応で**実際に読んで**書きました。Kotlin 版は、条件を満たさない組で `null` を返し、`evolve` が状態を変えずに返します。Scala 版は同じ組を `None` にし、`Ignored` にします。

**`game` ストリーム**（○ = `Applied`、× = `Ignored`）

| ID | イベント | `NotCreated` | `Preparing` | `Started` | 備考 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| EV-G01 | `GameCreated` | ○（→ `Preparing`） | × | × | |
| EV-G02 | `ParticipantJoined` | × | ○（新しい参加者のみ） | × | 同じ参加者の 2 回目は × |
| EV-G03 | `RoleAssigned` | × | ○（既知の参加者） | ○（既知の参加者。入れ替えの新担当者） | 未知の参加者は × |
| EV-G04 | `RoleUnassigned` | × | ○（既知の参加者） | × | 開始後の外れは `ParticipantReplaced` |
| EV-G05 | `ObserverInvited` | × | ○（未知の招待 ID のみ） | ○（同左） | 既知の招待 ID は変えない（`invited`）= × |
| EV-G06 | `ObserverInvitationRevoked` | × | ○（既知で失効していない招待のみ） | ○（同左） | 未知の招待と失効済みは変えない（`invitationRevoked`）= ×。初稿の Scala 版は 0 件だった |
| EV-G07 | `ObserverJoined` | × | ○（既知の招待で、未参加の観察者のみ） | ○（同左） | 未知の招待と参加済みの観察者は変えない（`observerJoined`）= × |
| EV-G08 | `CredentialRevoked` | × | ○（既知で未失効の主体のみ） | ○（同左） | 未知の主体と**失効済みは変えない**（`revoked`）= ×。入れ替えの自動失効を含み、**`assignRoleAfterStart` は未失効の旧担当者にだけ出す**（D3。R-H3） |
| EV-G09 | `CredentialReissued` | × | ○（失効済みの資格のみ） | ○（同左） | 未知の主体と失効していない資格は変えない（`reissued`）= × |
| EV-G10 | `ParticipationRecovered` | × | ○（既知で未失効の主体のみ） | ○（同左） | 未知の主体と失効済みは変えない（`recovered`）= ×。開始後の復帰（US3.2）に要る |
| EV-G11 | `GameStarted` | × | ○（→ `Started`） | × | |
| EV-G12 | `ParticipantReplaced` | × | × | ○（既知の参加者） | 未知の参加者は ×（Kotlin 版の変更表 38）。`Preparing`・`NotCreated` も × |

**`session` ストリーム**

| ID | イベント | `NotStarted` | `Active` | `Paused` | `Ended` | 備考 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| EV-S01 | `SessionStarted` | ○（→ `Active`） | × | × | × | |
| EV-S02 | `SessionPaused` | × | ○（→ `Paused`） | × | × | |
| EV-S03 | `SessionResumed` | × | × | ○（→ `Active`） | × | |
| EV-S04 | `SessionEnded` | × | ○（→ `Ended`） | **×** | × | **`Paused` は ×**（R-H3 で直した。前の版は ○ で、規則と矛盾していた）。`EndReason` は `FINAL_WEEK` だけで（`Session.kt`）、最終週の `WeekCommitted` と同じ追記（`SessionCommit.kt`。このとき状態は `Active`）でしか作られず、手動の終了は未実装。Kotlin 版の `evolveSession` は `Paused` からも `Ended` にするが、`handle` は作らない。Kotlin 版の設計書の図の「`Paused` → `Ended`」はコードにない |
| EV-S05 | `DecisionSaved` | × | ○ | × | × | 停止中の保存は `handle` が拒否する |
| EV-S06 | `ProxyDecisionSubmitted` | × | ○ | ○ | × | 進行役の代理入力は停止中も受ける（UC-09）。確定はしない。`NotStarted`・`Ended` は `handle` が拒否する |
| EV-S07 | `AutoCommitChanged` | - | - | - | - | **Kotlin 版のコード（`SessionEvent`）に存在しない**。EV-S10 と重複した表の記述（未決事項 12） |
| EV-S08 | `WeekCommitted` | × | ○（最終週なら同じ追記の `SessionEnded` が続く） | × | × | `Paused` は確定しない。再開で `AUTO` が揃えば、`SessionResumed` の後（`Active`）に続く |
| EV-S09 | `RoleHolderReplaced` | × | ○ | ○ | × | `NotStarted`・`Ended` は **`Ignored`**。`handle`（`assignRoleAfterStart`）が `NotActive`・`AlreadyEnded` で拒否するので作られない。条件はない（`withHolderReplaced` は `removed` を外して `added` を足すだけ） |
| EV-S10 | `CommitModeChanged` | × | ○ | ○ | × | `SetCommitMode` は**停止中も受け付ける**（`openData`）。`NotStarted`・`Ended` は `handle` が拒否する。有効にして 4 役割が揃えば、同じ追記で `WeekCommitted`（`AUTO`）が続く（`Active` のときだけ） |

**表の使い方（案。再々レビュー R-H4 で、生成器の作り方を直した）**: 「`handle` が作る列は `Ignored` にならない」の性質テストが捕まえたいのは、**表と `apply` の食い違いだけでなく、表そのものの漏れ**（P1 の本当の原因。前回の `Started` の表の漏れ）である。表から生成器を作ると、表が漏れていれば生成器も同じ漏れを持ち、見逃す。そこで 3 つの方向で確かめる（いずれもテストのソース。[テスト戦略](./test-strategy.md) は別の担当が同じ名前で書く）。

1. **(a) コマンドから作る列で `Ignored` が 0 件**（表の漏れを捕まえる）: 状態に応じて**コマンド**を選ぶ生成器（`Game.handle`・`Session.handle`・`startGame`・`assignRoleAfterStart` を通す）で列を作り、`foldLeft` で `apply` に渡して、`Ignored` が 0 件であることを確かめる。生成器の入力に使うのは**コマンドの種類と状態だけ**で、表は読まない。コマンドの種類に、準備中の割り当てと付け替え、観察者の招待・参加・取り消し、資格の失効・再発行・復帰、開始、保存・代理入力・確定・一時停止・再開・確定方式の変更、**開始後の入れ替え**（`assignRoleAfterStart`）を含める。**「資格の失効 → 同じ参加者が担当する役割への入れ替え」を、固定の流れとして必ず含める**（次の「開始後の役割の入れ替え」の D3 の穴。ここで落ちるのが、表と `handle` のずれの典型）。
2. **(b) 表の各 ○ の組が (a) の列の中で N 回以上現れる**（表が広すぎないかを捕まえる）: (a) の列で実際に `Applied` になった（状態の種類, イベントの種類）の組を `collect` で数え、表の ○ の組それぞれが N 回以上（N は B1 で決める。案: 100 件の列で 1 回以上）現れることを確かめる。現れない ○ は、`handle` が作らない組（表が広い）か、生成器が届かない組。**× の組は (a) で 0 件**（`Ignored` が 0 件であることと同じ）。
3. **(c) 表 × `apply` の全組の状態遷移テスト**（`apply` の腕の消し忘れ・足し忘れを捕まえる）: **全部の組**（12 × 3 と 9 × 4）を `apply` に渡し、表の ○ が `Applied`、× が `Ignored` になることを確かめる。条件つきの ○ は、条件を満たす例と、満たさない例の両方（上の表の条件の列）。

**表と値の 1 か所化**: 表は、テストが読む値（状態の種類 × イベントの種類 → 許す／許さない／条件）として**テストのソースの 1 か所**に持つ。この文書の表と食い違わないよう、**(i) その値から Markdown の表を生成するか、(ii) テストがこの文書の Markdown の表を読んで値と突き合わせる**のどちらかにする（どちらかは [テスト戦略](./test-strategy.md) の側で決める。AI の案）。状態遷移図は、この表から機械的に描ける形にする。**表を変えるときは、図・`apply`・テストの値を同じ変更で直す**。**合格の基準（B1 の表に入れる）**: 表の ○ を 1 つ × に変えると (a) が落ち、`apply` の腕を 1 つ消すと (c) が落ちること。

**この表の確認状況**: 表は、AI が Kotlin 版のコードと図から導いた案で、人の確認を得ていません。**再々レビューの対応で、条件つきの ○ の条件を Kotlin 版のコードで確かめました**（`revoked` は未知の主体と失効済みで変えない、`reissued` は未知の主体と失効していない資格で変えない、`recovered` は未知の主体と失効済みで変えない、`invited` は既知の招待で変えない、`invitationRevoked` は未知の招待と失効済みで変えない、`observerJoined` は未知の招待と参加済みで変えない、`withRole` は未知の参加者で変えない、`SetCommitMode` は停止中も受け付ける、`EndReason` は `FINAL_WEEK` だけ）。`decide` 側は、`decideRevoke`（未失効のみ）・`decideReissue`（失効済みのみ）・`decideRecover`（有効のみ）・`decideRevokeInvitation`（既知で未失効のみ）・`decideJoinAsObserver`（使える招待のみ）が、`evolve` の条件と同じ前提を検査していることも読んだ。**読んでいないもの**: `decideInvite` は招待 ID の重複を検査しない（ID は生成器が作る前提。重複すると Scala 版は `Ignored`）、`startGame` と各コマンドの全分岐が (a) の生成器で網羅されるか（B1 で (b) の `collect` で確かめる）。**Kotlin 版の潜在不具合**（`assignRoleAfterStart` の `ReplaceDecision.kt` が、失効済みの旧担当者にも `CredentialRevoked` を出す）は、下の「開始後の役割の入れ替え」と未決事項 16 に書いた。

#### 開始後の役割の入れ替えと `Started` の自己遷移（H2・N-H1。AI の案、承認を得ていない）

Kotlin 版は、開始後の入れ替えを `Started` の**自己遷移**として扱います（[Kotlin 版の「役割の入れ替え」](../beer-game-kotlin/domain-model.md) と変更表 37・38）。Scala 版の初稿は、`RoleAssigned` を `Preparing` だけが受け、`ParticipantReplaced` を持たなかったため、**入れ替えたゲームが `Ignored` になり、「止める」設計（ユーザーの決定、2026-11-25）と合わせると、研修中に担当者を入れ替えたゲームが操作不能になる**状態でした。1 回目の直しでも、`Started` の腕は `RoleAssigned`・`ParticipantReplaced`・`CredentialRevoked` だけで、状態遷移図より狭く、観察者の招待・資格の再発行・復帰を `Ignored` にしていました（再レビュー N-H1）。上の表のとおり直します。

| ストリーム | 状態 | イベント | 遷移 |
| :--- | :--- | :--- | :--- |
| `game` | `Started` | `RoleAssigned`（入れ替えの新担当者） | 参加者の役割を付ける（自己遷移）。未知の参加者は `Ignored` |
| `game` | `Started` | `ParticipantReplaced`（旧担当者。`replacedBy` を持つ） | 旧担当者の役割を外す。参加者の行・表示名・過去の入力は消さない（自己遷移）。**未知の参加者は `Ignored`** |
| `game` | `Preparing`・`Started` | `ObserverInvited`・`ObserverInvitationRevoked`・`ObserverJoined`・`CredentialRevoked`（入れ替えの自動失効を含む）・`CredentialReissued`・`ParticipationRecovered` | 招待・観察者・資格の状態を更新する（自己遷移）。**条件つき**（上の表の条件の列。条件を満たさなければ `Ignored`。R-H3） |
| `session` | `Active`・`Paused` | `RoleHolderReplaced`（`removed`・`added`） | `SessionData.assignments[role]` を更新する（自己遷移） |
| `session` | `NotStarted`・`Ended` | `RoleHolderReplaced` | **`Ignored`**（`Applied(s)` ではない。Kotlin 版の「状態を変えない」を、Scala 版では `Ignored` として検知する。`handle` が作らないので、出たら不具合） |

```plantuml
@startuml
title game ストリームの状態（開始後の入れ替えを含む。Scala 版。上の許す組の表から描く）
[*] --> NotCreated
NotCreated --> Preparing : GameCreated
Preparing --> Preparing : ParticipantJoined\nRoleAssigned / RoleUnassigned\nObserverInvited / ObserverInvitationRevoked\nObserverJoined\nCredentialRevoked / CredentialReissued\nParticipationRecovered
Preparing --> Started : GameStarted
Started --> Started : ObserverInvited / ObserverInvitationRevoked\nObserverJoined\nCredentialRevoked / CredentialReissued\nParticipationRecovered\n役割の入れ替え: ParticipantReplaced\n+ CredentialRevoked + RoleAssigned
@enduml
```

**入れ替えは `assignRoleAfterStart`（`game` と `session` の両方を入力に取る関数）が、1 回の追記で返します**。`game` に `ParticipantReplaced`（旧担当者ごとに 1 件）・`CredentialRevoked`・`RoleAssigned`、`session` に `RoleHolderReplaced` を返し、旧担当者の資格の失効と `session` の写しの更新を同じ追記で行います（Kotlin 版と同じ規則。1 人だけ外す案、終了後の扱い、イベント名と形は Kotlin 版のゲート 3.5 の未決事項に追従する）。

**失効済みの旧担当者の扱い（再々レビュー R-H3 (d)。D3。ユーザーの指示に基づき AI が推奨案で決めた。確認は未了）**: Kotlin 版の `assignRoleAfterStart`（`ReplaceDecision.kt`）は、旧担当者の**全員に `CredentialRevoked` を無条件に出します**。一方 `evolveGame` の `revoked()` は、失効済みの資格には `null` を返し、状態を変えません。Kotlin 版は `null` を黙って受けるので動きますが、Scala 版の `apply` は同じ組を `Ignored` にし、**コマンドの経路では止める**ため、次の流れでゲームが止まります: 進行役が参加者 P1（役割 R の担当）の資格を失効させる（`CredentialRevoked(P1)`）→ 進行役が別の参加者 P2 を R に割り当てて入れ替える → `ReplaceDecision` が P1 に再び `CredentialRevoked` を出す → `Ignored` → 500。「失効 → 入れ替え」は自然な流れ（資格を失効させてから担当を替える）で、Kotlin 版でも `replayGame` が `InvalidTransition` として記録する（Kotlin 版のテスト `ReplaceRoleSpec.kt` にこの組はない）。

案は 2 つ: (a) **旧担当者のうち、資格が未失効の人にだけ `CredentialRevoked` を出す**（採用。`assignRoleAfterStart` の側を直す。`apply` と表は変えない）、(b) EV-G08 を失効済みの主体にも届く冪等な ○ にする（表と `apply` を広げる。`revoked()` の「失効済みは変えない」という Kotlin 版の条件から外れる）。**(a) に決めた理由**: 失効済みの資格をもう一度失効させる事実は、何も変えないのにイベントの列に残り、再生の `Ignored` の検査を弱める。表を狭いまま保つほうが、P1 の検知（(a) の生成器）が効く。

```scala
// assignRoleAfterStart の game 側のイベントの導出（スケッチ。型検査していない）
def replacementEvents(d: GameData, incoming: ParticipantId, role: Role): List[GameEvent] =
  val outgoing = d.participants.collect { case (p, Some(`role`)) => p }.toList.sortBy(_.value)
  outgoing.flatMap { p =>
    val sub = CredentialSubject.Participant(p)
    GameEvent.ParticipantReplaced(p, role, incoming) ::
      Option.when(d.credentials.get(sub).exists(!_.revoked))(GameEvent.CredentialRevoked(sub)).toList   // 未失効だけ（D3）
  } :+ GameEvent.RoleAssigned(incoming, role)
```

新しい担当者の資格が失効済みなら、Kotlin 版と同じく `CredentialAlreadyRevoked` で拒否する（`data.credentials[subject]?.revoked == false` の検査。再生では新しい担当者の資格が未失効である前提）。Kotlin 版の `ReplaceDecision.kt` は変えない（Scala 版の設計書の範囲外）。**正本側の整理が要る**（未決事項 16）。

**この要件を、テストに必ず入れます**（テスト戦略は別の担当が書くため、ここでは domain-model の要件として書く）。

- **受入テスト（再レビュー N-H1。現場で最も起きやすい流れ）**:
  1. 「開始後に担当者を入れ替えたゲームで、新担当者が意思決定を保存でき、週を確定できる（再生しても同じ状態が復元される）」。
  2. 「**停止中に入れ替え → 進行役が代理入力 → 再開して確定**」。`Paused` は `RoleHolderReplaced` と `ProxyDecisionSubmitted` を受け（上の表）、再開（`SessionResumed`）の後に週を確定できる。再生しても同じ状態になる。
  3. 「**入れ替え後の再開で、保存できるのは新担当者だけ**」。旧担当者の資格は失効し、保存は 403（`app.unauthorized` と同じ本文）。新担当者は保存できる。
  4. 「開始後の復帰（`ParticipationRecovered`）、観察者の招待と参加・招待の取り消し、資格の再発行が、開始後のゲームで `Ignored` にならず、続けて保存・確定できる」（U2 の約束の範囲）。
  5. 「**失効 → 入れ替え → 新担当者が保存・確定 → 再生しても同じ状態**」（再々レビュー R-H3 (d)。D3）。進行役が参加者 P1（役割 R の担当）の資格を失効させ、続けて P2 を R に入れ替える。`CredentialRevoked` が P1 に**重ねて出ない**（出るとゲームが止まる）こと、新担当者 P2 が保存でき、週を確定できること、イベントの列を再生すると `Ignored` が 0 件で同じ状態になることを確かめる。入れ替え前に資格が未失効の旧担当者には `CredentialRevoked` が 1 件出ることも、別の例で確かめる（件数の確認）。
  - 共有の `apps/beer-game-features/continuation/credentials.feature`（`@AC3.2.5`）と二重になる部分は、テスト戦略の別の担当が許可リストの形で整理する。
- **性質テスト**: 「`handle` が作る列は `Ignored` にならない」の生成器に、**開始後の入れ替え（`assignRoleAfterStart`）、観察者の招待・参加・取り消し、資格の失効・再発行、復帰を含める**。生成器は、**上の「許す組の表」からではなく、コマンドから作る**（再々レビュー R-H4。「表の使い方」の (a)(b)(c) の 3 方向）。「失効 → 入れ替え」の流れを固定の流れとして入れる。生成器が入れ替えなどを作らないと、遷移の腕の漏れを検知できない。
- **「許さない組の拒否」のテスト**: 表の × の組を、すべて `apply` に渡して `Ignored` になることを確かめる。たとえば `Preparing` や `NotCreated` が `ParticipantReplaced` を受けても状態を変えない（`Ignored`）、未知の参加者への `ParticipantReplaced` は `Ignored`、`NotStarted`・`Ended` の `RoleHolderReplaced` は `Ignored`。

### Session 集約（進行）

ストリームは `session`。責務、State（`NotStarted`・`Active`・`Paused`・`Ended`）、Command、不変条件（意思決定の条件、保存回数の上限 9 回、共同入力、代理入力、役割の確認、週確定の条件と一回性、自動確定、終了、権限、非負・保存則）、状態遷移は Kotlin 版を引き継ぎます。Scala での形のスケッチ（**型検査していない**）:

```scala
enum SessionState:
  case NotStarted
  case Active(data: SessionData)
  case Paused(data: SessionData)
  case Ended(data: SessionData)

final case class SessionData(
    gameId: GameId,
    settings: GameSettings,                       // 開始時の写し
    assignments: RoleMap[Set[ParticipantId]],     // 開始時の写し（入れ替えだけが変える）
    week: Week,
    roleStates: RoleMap[RoleState],
    decisions: Map[Role, DecisionEntry],          // 当週。確定でクリア
    decisionVersions: RoleMap[DecisionVersion],   // 当週の版。確定で 0
    commitMode: CommitMode
)

object Session:
  def handle(state: SessionState, command: SessionCommand): Either[SessionError, List[SessionEvent]] =
    command match
      case SessionCommand.SaveDecision(actor, _, role, requestedWeek, quantity, expected) =>
        for
          data <- active(state)                        // 進行中でなければ NotActive / Paused / AlreadyEnded
          // 判定順: 権限 → 週(WeekAdvanced) → 版(DecisionConflict) → 保存回数の上限
          saved  = SessionEvent.DecisionSaved(/* … */)
          after <- applyDecided(state, saved)          // 保存直後の状態。Ignored（handle が作らない列）なら失敗させる（下記）
          auto  <- autoCommitEvents(after, command)    // AUTO で 4 役割が揃えば WeekCommitted（+ SessionEnded）
        yield saved :: auto
      // CommitWeek: (1) 週が違えば WeekAdvanced (2) basis が違えば DecisionsChanged (3) 揃っていなければ IncompleteDecisions
      // SubmitProxyDecision: 進行役だけ。進行中または一時停止中で受け付け（activeOrPaused(state)）、
      //   requestedWeek が現在の週と違えば WeekAdvanced。一時停止中は自動確定しない（再開時に判定）
      // …
```

**停止中の代理入力**: `SubmitProxyDecision`（進行役）は、`SaveDecision`（参加者）と違い、**一時停止中も受け付けます**（UC-09: 停止 → 代理入力 → 再開）。**進行中で `AUTO` かつ 4 役割が揃えば自動確定し、一時停止中は確定しません**（`SetCommitMode(AUTO)` も同じ。再開時に判定する）。Kotlin 版は初版でここを「進行中のみ」と誤り、レビューで直した経緯があるため、Scala 版は最初から明記します。

**`Ignored` の扱い**: `applyDecided` は、保存直後の状態を求め、`Ignored` が出たら**失敗**にします（`handle` が作る列は `Ignored` にならないはずなので、出た場合は不具合）。**コマンドの経路で、保存済みのイベントの再生中に `Ignored` が出た場合も、状態を信用せず `AppFailure.Persistence`（500・相関 ID）で失敗させます**（[バックエンドアーキテクチャ](./architecture-backend.md)。fail closed）。再生を診断する用途（`verify-projections` など）では、`Ignored` を記録して続けます。**コマンドの経路で止める設計は、ユーザーの決定（2026-11-25、H3）で維持します**。ただし、これは Kotlin 版（状態を変えずに記録して続行）からの**利用者に見える変更**です（下の変更表の 10。運用は [バックエンドアーキテクチャ](./architecture-backend.md) の「`Ignored` で止めること」）。

自動確定は、Kotlin 版と同じく **1 回の `handle` が複数のイベントを返す**ことで表します（D6）。`WeekCommitted` は結果と次週の状態を事実として含み、`SessionEvents.apply` はそれを採用するだけで、`simulateWeek` を呼び直しません（D5）。

#### 状態遷移

状態遷移図は [Kotlin 版](../beer-game-kotlin/domain-model.md) の `session ストリームの状態` と同じです（`NotStarted` → `Active` ⇄ `Paused` → `Ended`）。**`Active`・`Paused` は `RoleHolderReplaced`（開始後の入れ替え）を自己遷移として受けます**（上の「開始後の役割の入れ替えと `Started` の自己遷移」）。遷移の「許す組」は、上の「遷移の許す組の表」（規範）から `match` に列挙し、許さない組の拒否はテストで確かめます（ガイド §7.3、§10.2）。Kotlin 版の図が `Paused` の自己遷移に載せているのは `AutoCommitChanged`・`ProxyDecisionSubmitted`・`RoleHolderReplaced` で、Scala 版の表はそれに `CommitModeChanged`（Kotlin 版のコードの実際のイベント）を合わせます。**ただし、Kotlin 版の図の「`Paused` → `Ended`」と「進行役の終了」は、Kotlin 版のコードにありません**（`EndReason` は `FINAL_WEEK` だけで、`SessionEnded` は最終週の `WeekCommitted` と同じ追記でだけ作られる。手動の終了は未実装）。Scala 版の表は `Paused` の `SessionEnded` を × にします（R-H3）。

#### `SessionEvents.apply` のスケッチ（R-H3 (e)。型検査していない。AI の案）

`game` 側（`GameEvents.apply`）と同じ形で、表の ○ の組だけを腕にします。上の表にない組は、最後の腕の `Ignored` です。Kotlin 版の `evolveSession`（`SessionEvolve.kt`）は、`DecisionSaved`・`WeekCommitted`・`SessionEnded` を `Paused` でも適用しますが、Scala 版は `handle` が作る組（`Active`）だけを受けます。

```scala
object SessionEvents:
  /** Active・Paused のときだけデータを更新する（種類は変えない）。NotStarted・Ended は Ignored */
  private def updateOpen(s: SessionState)(f: SessionData => SessionData): Evolution[SessionState] = s match
    case SessionState.Active(d) => Evolution.Applied(SessionState.Active(f(d)))
    case SessionState.Paused(d) => Evolution.Applied(SessionState.Paused(f(d)))
    case other                  => Evolution.Ignored(other)

  def apply(state: SessionState, event: SessionEvent): Evolution[SessionState] =
    (state, event) match
      // 腕は、上の「遷移の許す組の表」（session）の ○ の組だけ
      case (SessionState.NotStarted, e: SessionEvent.SessionStarted) =>                       // EV-S01
        Evolution.Applied(SessionState.Active(SessionData.initial(e)))                         // 設定・割り当て・初期状態・確定方式の写し（D4）
      case (SessionState.Active(d), SessionEvent.SessionPaused)      => Evolution.Applied(SessionState.Paused(d))    // EV-S02
      case (SessionState.Paused(d), SessionEvent.SessionResumed)     => Evolution.Applied(SessionState.Active(d))    // EV-S03
      case (SessionState.Active(d), _: SessionEvent.SessionEnded)    => Evolution.Applied(SessionState.Ended(d))     // EV-S04。Paused は Ignored
      case (SessionState.Active(d), e: SessionEvent.DecisionSaved)   =>                                              // EV-S05。Paused は Ignored
        Evolution.Applied(SessionState.Active(d.withDecision(e.role, DecisionEntry(e.quantity, e.decisionVersion, e.editor))))
      case (s @ (SessionState.Active(_) | SessionState.Paused(_)), e: SessionEvent.ProxyDecisionSubmitted) =>        // EV-S06。停止中も受ける
        updateOpen(s)(_.withDecision(e.role, DecisionEntry(e.quantity, e.decisionVersion, e.editor)))
      case (SessionState.Active(d), e: SessionEvent.WeekCommitted)   =>                                              // EV-S08。結果と次週の状態を採用するだけ（D5）
        Evolution.Applied(SessionState.Active(d.afterCommit(e)))
      case (s @ (SessionState.Active(_) | SessionState.Paused(_)), e: SessionEvent.RoleHolderReplaced) =>            // EV-S09。条件なし
        updateOpen(s)(_.withHolderReplaced(e.role, e.removed, e.added))
      case (s @ (SessionState.Active(_) | SessionState.Paused(_)), e: SessionEvent.CommitModeChanged) =>             // EV-S10。停止中も受ける
        updateOpen(s)(_.copy(commitMode = e.commitMode))
      case (s @ (SessionState.NotStarted | SessionState.Active(_) | SessionState.Paused(_) | SessionState.Ended(_)), _) =>
        Evolution.Ignored(s)
```

`game` と違い、session の条件つきの ○ は無く、状態の種類で決まります（`withHolderReplaced` は `removed` を外して `added` を足すだけで、条件を持たない。`NotStarted` が受けるのは `SessionStarted` だけで、`Ended` はどのイベントも受けない）。**型検査していません**。

### 2 ストリームにまたがる StartGame

開始は、`game` に `GameStarted`、`session` に `SessionStarted` を**同一トランザクションで**追記する唯一のコマンドです（D3）。Scala 版でも、2 ストリームを入力に取る独立の関数にします。

```scala
final case class StartDecision(game: List[GameEvent], session: List[SessionEvent])

def startGame(game: GameState, session: SessionState, command: StartGame): Either[DomainError, StartDecision] =
  // 判定順: 権限 → 開始済み(AlreadyStarted) → 開始条件(StartConditionNotMet)
  ???   // スケッチ。実装では `???` を使わない（Wart.TripleQuestionMark）
```

開始後の役割の入れ替え（`assignRoleAfterStart`）も、`game` と `session` の両方を入力に取る同じ形の関数です。`DomainError` は `GameError` と `SessionError` を包む `enum` とし、統合のエラー型を B1 の最初のスライドで決めます（Rust 版の未決事項と同じ。未決事項 3）。

### 週次計算（simulateWeek）

```scala
final case class WeekOutcome(results: RoleMap[RoleWeekResult], nextStates: RoleMap[RoleState])

def simulateWeek(
    settings: SimulationSettings,       // 最終週、需要系列、費用方針
    week: Week,
    states: RoleMap[RoleState],         // 前週末の断面
    decisions: RoleMap[Quantity]        // 4 役割の当週の発注数または生産要請数
): WeekOutcome
```

- **全域**です（`Either` を返さない）。入力の型が検証済みのため失敗しません。
- 永続化・時刻・乱数・通信に依存しません。決定論性（NFR-01）は、この関数が副作用を持たないことで保たれます。
- 規則（12 ステップ、遅延、利用可能量・充足対象・出荷・週末在庫・受注残・費用の式）は、Kotlin 版・beer-game2 と同じで、**本書は新しい規則を加えません**。
- 数量の演算は、`Units`・`Money` を `Long` にして桁あふれを避けます（SD7。Kotlin 版は `Int` で、上限 1000 の前提）。範囲は未決事項 4 で確かめます。
- 検証は、既知の系列の golden test、ScalaCheck による性質テスト（在庫・受注残が非負、出荷が利用可能量を超えない）、**計算と事実の一致**（`foldLeft` の再生の結果が、イベントのペイロードと `simulateWeek` を直接回した結果の両方と一致する）です（ガイド §8.3）。

### RetentionSaga（プロセスマネージャー）

Kotlin 版の D8 のとおり、ES にせず、状態の行を持つプロセスマネージャーにします。遷移は純粋な `handle` / `apply` で、状態は `enum RetentionState`（`Pending`、`InProgress`、`Failed`、`Completed`、`Abandoned`）、不変条件（一度だけ、再試行は最大 5 回の指数バックオフ、完了の定義は `game_roots` の削除の成功、削除後に行が残らない）は Kotlin 版を引き継ぎます。バックオフの揺らぎは、呼び出し側が引いて渡し、ドメインは乱数・時計を読みません。

### 代数構造の適用範囲（SD6）

ガイド第 6 章の 5 つの構造のうち、本ドメインで使うものと使わないものを、§6.5 の手順（強い構造から確かめ、足りる弱いものを選ぶ）で決めます。

| 構造 | 本ドメインでの使いどころ | 扱い |
| :--- | :--- | :--- |
| モナド（`for`） | `handle` の連鎖（読む、検証する、イベントを作る）。`Either` の `for` | 使う |
| アプリカティブ（`ValidatedNec`・`mapN`） | 境界の検証で誤りを全件集める | 使う |
| ファンクタ（`map`） | `RoleMap[A]` の `map`（4 役割に同じ変換を掛ける）。`Functor[RoleMap]` の `given` を置き、恒等則・合成則をテストで確かめる | 使う（法則のテストを書く） |
| モノイド | `WeekTeamTotals`（チーム合計と寄与者数）の畳み込み。`TeamTotals` の `Monoid`（`empty` は 0 と寄与者 0）。観察用の合計は、役割別の値を持たない | 使う（法則のテストを書く。結合律と単位元） |
| プロファンクタ（`dimap`）・`imap` | `EventCodec`（行きと戻りの写像）。ドメインでなく永続化の層の話で、[バックエンドアーキテクチャ](./architecture-backend.md) に書く | ドメインでは使わない |

イベントの再生（`foldLeft`）を `StateTransition` の `Monoid`（ガイド §6.1）で表す案は、`foldLeft` で足りるため採りません。

## ドメインイベント

イベントの一覧（EV-G01〜G12、EV-S01〜S10）、発生条件、ペイロードは、[Kotlin 版のドメインイベント](../beer-game-kotlin/domain-model.md) を正本として**引き継ぎます**（名称も変えません。イベントは永続化され、投影と契約の一部になるため）。

- **コードから生成した一覧**: Kotlin 版は型の注釈から生成します（ADR-018）。Scala 版の生成方式は**未決**です（[ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md) の 018。置き換え）。出力先は `docs/design/beer-game-scala/generated/`（コード着手後）。
- **名称の差**: Kotlin 版の設計書の表には `RoleHolderReplaced`（EV-S09）があり、Rust 版の実装は `RoleReplaced` としています。Scala 版は**設計書の表の名前（`RoleHolderReplaced`）を採ります**。Rust 版の差は Scala 版に引き継ぎません。
- ペイロードの JSON は、**adapter（`adapter-persistence` の `EventCodec`）の DTO** を、`event_type` を判別子にした形で表します（**ドメインのイベントの型には codec を付けない**。BD5。形は [バックエンドアーキテクチャ](./architecture-backend.md)）。
- 表示名と資格の値は、ペイロードに含めません（D7）。型の上でも、`GameEvent` のフィールドに `DisplayName` と資格のダイジェストの型を**持たせません**。

## 投影（読み取りモデル）

投影は、イベント 1 件から読み取り用の**行の変更の列**を作る純粋関数です。他の投影を読みません。SQL は知りません。再構築は、イベントの列への `flatMap` です（ガイド §7.5）。

```scala
enum RowChange:
  case Upsert(table: ProjectionTable, key: RowKey, values: Map[Column, Value])
  case Delete(table: ProjectionTable, key: RowKey)

type Projection = EventEnvelope[DomainEvent] => List[RowChange]
```

投影の一覧（`GameOverview`、`GameJoinCodes`、`GameSettingsView`、`Lobby`、`SessionOverview`、`RoleCurrentState`、`CurrentDecisions`、`WeekRoleResults`、`WeekTeamTotals`、`RetentionPolicyView`）、購読するイベント、閲覧できる人、**出力 `buildExport` を投影にしない**こと（D11）、**開示の判定（`Disclosure`）**、観察者が読める 3 表の制限は、Kotlin 版を引き継ぎます。

## 設計判断

### Kotlin 版の設計判断 D1〜D11 との対応

| ID | Kotlin 版の決定 | Scala 版の扱い |
| :--- | :--- | :--- |
| D1 | ストリームは `game` と `session` の 2 本 | **引き継ぐ** |
| D2 | ゲームの終了は投影で導出（`game` に書かない） | **引き継ぐ** |
| D3 | `StartGame` は 2 ストリームへの原子的な追記 | **引き継ぐ**（`startGame` 関数） |
| D4 | `SessionStarted` が設定と割り当ての写しを運ぶ | **引き継ぐ** |
| D5 | `WeekCommitted` は結果と次週の状態を事実として含む | **引き継ぐ**（`SessionEvents.apply` は `simulateWeek` を呼ばない） |
| D6 | 自動確定は `decide` が複数イベントを返す | **引き継ぐ**（`handle` が `List` を返す） |
| D7 | 個人情報と秘密は周辺ストアへ | **引き継ぐ**（型でも持たせない） |
| D8 | RetentionSaga はプロセスマネージャー | **引き継ぐ** |
| D9 | 共同担当の付け替えは 2 イベント | **引き継ぐ**（上の `Game.handle` で確認した形） |
| D10 | `CommitWeek` の前提は週と意思決定の版 | **引き継ぐ** |
| D11 | 出力は投影にせず純粋関数で作る | **引き継ぐ** |

### Scala 固有の判断 SD1〜SD7

**SD1〜SD7 は、AI が起草した案で、ユーザーの承認を得ていません。ただし SD2 のうち「コマンドの経路で `Ignored` が出たら止める（fail closed）」はユーザーの決定（2026-11-25、H3）です**（再レビュー M16 で区別した）。SD2 のほかの部分（`Evolution.Applied / Ignored` の形、版を永続化の層が持つこと）は AI の案で、承認を得ていません。

| ID | 判断 | Kotlin 版・Rust 版との関係 |
| :--- | :--- | :--- |
| SD1 | 型の表現: 状態・コマンド・イベント・エラーは `enum`、複合値は `case class`（`copy`）、検証つきの値は `opaque type` | Kotlin の `sealed interface`・`value class`、Rust の `enum`・newtype に対応 |
| SD2 | 失敗と遷移: 業務の失敗は `Either[業務の enum, A]`。遷移は `Events.apply` が `Evolution.Applied / Ignored` を返し、版は永続化の層が持つ。**`IO` の失敗は想定外に限る**（ガイド ADR-050） | Kotlin は `State.version` と版の増加で検知（変更）。Rust の RD2 と同じ |
| SD3 | 検証: 独立な検証は `ValidatedNec` と `mapN` で全件集める。連鎖する検証は `Either` の `for` | Kotlin の `zipOrAccumulate`、Rust の `collect` に対応 |
| SD4 | エラーの `code` と `category` は `enum` の `match` の網羅で付け、`-Werror` で付け忘れを止める。一覧は API の契約として固定 | Rust の RD4 と同じ |
| SD5 | 純粋性: `domain` は `cats-core` だけに依存し、`println`・時計・乱数・`UUID.randomUUID`・`cats.effect` の `import` を Scalafix の `DisableSyntax` で禁止する | Kotlin の detekt `ForbiddenMethodCall`、Rust の RD5 に対応。**文字列のパターンの限界あり**（ガイド §9.4）。依存の制限が主、Scalafix が従 |
| SD6 | 代数構造は、`Functor[RoleMap]`・`Monoid[TeamTotals]`・`ValidatedNec`・`Either` の `for` に限り、法則をテストで確かめる。再生の `Monoid` 化は採らない | ガイド第 6 章。Kotlin 版・Rust 版には無い |
| SD7 | 数量の幅: `Quantity` は `Int`（0〜1000）、`Units`・`Money` は `Long` | Kotlin は `Int`。Rust は未決（`u32`・`u64`/`i64` を第一候補）。範囲は未決事項 4 |

#### SD1: 状態の違いは `enum` の列挙子で表し、網羅は `match` に任せる

Kotlin 版の `sealed interface` + `when`（else なし）に対応します。Scala の `match` は、`enum` の網羅性をコンパイラが検査し、`-Werror` で警告が失敗になります（ガイド §3.3、§9.2）。状態・イベント・エラーの列挙子を足したときに、見直す箇所が分かります。ただし、`Events.apply` の最後の腕に `_` を使うと、**イベントの追加の見落としは検出できません**（上記）。このため、「`handle` が作る列は `Ignored` にならない」性質テストを必須にします。また、文字列から読み戻す境界の `match` は型で止まらないため、境界で未知の値を失敗として扱い、テストで確かめます（ガイド §9.2、§10.2）。

#### SD2: ストリームの版は状態に持たせず、永続化の層が持つ。遷移は `Evolution` で適用の有無を返す

Kotlin 版は `State.version` を持ち、`evolve` が版を進めて、再生側が「版が増えなかった」ことで不正な遷移を検出します。Scala 版は、Rust 版の RD2 と同じく、`Evolution.Applied / Ignored` で**明示**し、版は `(state, version)` として永続化の層が数えます（ガイド §7.6 の `Versioned(version, events)` と同じ形）。**これは Kotlin 版からの設計の変更**です。

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用の提案）** | `Evolution` で適用の有無を返し、版は外で持つ | 検知が直接的。状態の型が小さい。再生は `foldLeft` で `Evolution` を畳み込む |
| B | Kotlin 版と同じく、状態に版を持たせ、再生が前後を比べる | 構造が Kotlin 版と一致する。検知が間接的 |
| C | ガイドの例のとおり `apply(state, event): State` だけを返し、不正な遷移は状態を変えずに返す | 最も単純。不正な遷移を検知する手段がなくなる（`Ignored` に当たる情報が失われる） |

「`IO` の失敗は想定外に限る」ため、業務の失敗は `Either`、再生で出る `Ignored` の扱いは `AppFailure.Persistence`（想定外。500・相関 ID）に写します。

#### SD3〜SD7

SD3（`ValidatedNec`）は上の「検証の誤りと業務ルールの失敗」、SD4（`code` の網羅）は「エラーの分類と `code`」、SD5（純粋性）は「設計の前提と原則」、SD6（代数構造）は「代数構造の適用範囲」、SD7（数量の幅）は「値オブジェクト」に書いたとおりです。SD7 は、`Int` のまま `Math.addExact` などの検査付き演算を使う案もありますが、これは桁あふれで例外を投げ、例外を使わない原則と合いません。**`Long` に広げて桁あふれを避けるほうが原則に合う**と判断しました（未決事項 4 で範囲を確かめる）。

## beer-game-kotlin からの変更

| # | beer-game-kotlin | beer-game-scala | 理由 |
| :--- | :--- | :--- | :--- |
| 1 | `sealed interface`・`data class`・`value class` | `enum`・`case class`・`opaque type` | 言語の違い |
| 2 | `Either<DomainError, List<Event>>`、`Raise` | `Either[Error, List[Event]]`、`for`（SD2） | 標準で足りる |
| 3 | `zipOrAccumulate`（Arrow） | `ValidatedNec` と `mapN`（cats-core） | ガイド §6.3 |
| 4 | `State.version` と版の増加による不正な遷移の検知 | `Evolution.Applied / Ignored`、版は永続化の層（SD2） | 検知を直接にする |
| 5 | `evolve(state, event): State` | `Events.apply(state, event): Evolution[State]` | 同上 |
| 6 | 純粋性は detekt の `ForbiddenMethodCall` | 依存の制限（cats-core だけ）+ Scalafix の `DisableSyntax`（SD5） | ツールの違い |
| 7 | `Int`、`Money` は最小単位の整数 | `Units`・`Money` は `Long`（SD7） | 桁あふれを避ける |
| 8 | 型の注釈（`@Term`・`@EventSpec`）から用語集・イベント一覧を生成 | 方式は未決（ADR-001 の 018 は置き換え） | 注釈は Kotlin の機能 |
| 9 | 代数構造は使わない（Arrow の `Raise` が中心） | `Functor[RoleMap]`・`Monoid[TeamTotals]` を使い、法則をテストする（SD6） | ガイド第 6 章 |
| 10 | コマンドの経路で不正な遷移（`Ignored` に当たる組）が出ても、状態を変えずに `InvalidTransition` を記録して続行する | **コマンドの経路で `Ignored` が出たら、`AppFailure.Persistence`（500・相関 ID）で処理を止める**（fail closed）。診断の用途だけ、記録して続行する。**利用者に見える変更**: 該当するゲームの保存・確定などが失敗し続け、運用の復旧まで続けられない | 保存済みの事実を無視した状態で `handle` すると不変条件が崩れるため。**止める設計はユーザーの決定（2026-11-25、H3）**。影響と運用（進行役への依頼の文言、研修中の原則）は [バックエンドアーキテクチャ](./architecture-backend.md) の「`Ignored` で止めること」と運用要件に置く |
| 11 | `evolveGame` の `RoleAssigned` は開始後も役割を付け、`ParticipantReplaced` は開始後だけ旧担当者の役割を外す（Kotlin 版の変更表 38）。観察者の招待・参加・取り消し、資格の失効・再発行、復帰は準備中・開始後の両方で受ける | **同じ**。`Started` の自己遷移として、`RoleAssigned`・`ParticipantReplaced`・`ObserverInvited`・`ObserverInvitationRevoked`・`ObserverJoined`・`CredentialRevoked`・`CredentialReissued`・`ParticipationRecovered`（game）と `RoleHolderReplaced`（session）を受ける。未知の参加者への `ParticipantReplaced` は `Ignored`。session の `NotStarted`・`Ended` の `RoleHolderReplaced` も `Ignored`。初稿は `RoleAssigned` 以外を持たず、1 回目の直しも状態遷移図より狭かった（H2・再レビュー N-H1） | Kotlin 版に追従。`Ignored` で止める設計と合わせると、持たないと入れ替えたゲームや、復帰・再発行・観察者の招待をしたゲームが操作不能になる |
| 12 | 権限を先に判定し、権限のない人に状態を知らせない（Kotlin 版の原則） | `AssignRole` の判定順を、権限 → 準備中か → 参加者の存在にそろえる（L6。本書の初稿は準備中かが先だった）。作成前は `Forbidden` | Kotlin 版の原則に合わせる |
| 13 | 遷移の「許す組」の正本は、`evolve` のコードと状態遷移図（どちらも手で書く） | **「許す組の表」（EV × 状態）を規範**にし、`apply`・図・状態遷移テストをこの表から導く。**性質テストの生成器は、表からでなくコマンドから作る**（N-H1・R-H4。AI の案） | 止める設計では、組の漏れが研修の停止になる。スケッチや図を基準にすると漏れを見逃す |
| 14 | `AutoCommitChanged`（EV-S07）と `CommitModeChanged`（EV-S10）が表に並ぶ。コードにあるのは `CommitModeChanged` だけ | 表（許す組の表）には `CommitModeChanged` だけを置き、EV-S07 は重複の疑いとして未決事項 12 に置く | Kotlin 版の `SessionEvent` に `AutoCommitChanged` が無い（`SessionEvolve.kt` の `when` で確認） |

| 15 | `assignRoleAfterStart` は旧担当者の全員に `CredentialRevoked` を出す。`evolve` は失効済みで状態を変えず、記録して続行する | **未失効の旧担当者にだけ `CredentialRevoked` を出す**（D3。R-H3）。失効済みの旧担当者には `ParticipantReplaced` だけ | `Ignored` で止める設計（変更表 10）と合わせると、「失効 → 入れ替え」でゲームが止まるため。ユーザーの指示に基づき AI が推奨案で決めた（確認は未了） |
| 16 | `evolveSession` は `Paused` でも `DecisionSaved`・`WeekCommitted`・`SessionEnded` を適用する | `SessionEvents.apply` は `Active` だけが受ける（`handle` が作る組だけ ○）。`ProxyDecisionSubmitted`・`RoleHolderReplaced`・`CommitModeChanged` は `Paused` も受ける | `handle` が作らない列を `Ignored` として検知する（変更表 10・13） |

上記以外（ストリームの構造、イベントの名称と意味、投影、週次計算の規則、エラーコード、開示の規則）は変えません。

## 未決事項

1. **SD1〜SD7 の承認**: 人の承認を得る。特に SD2（Kotlin 版の `State.version` からの変更）と SD7（`Long`）。
2. **エラー型の `message`**（`Display` に当たるもの）: 文言は仮置き。境界（HTTP）で日本語の文言を決めるか、ドメインは `code` だけを持つか。
3. **統合のエラー型**（`DomainError`。`GameError`・`SessionError` を包む）と、`Projection` の `DomainEvent`: B1 の最初のスライドで決める。
4. **数量・金額の整数の幅**（SD7）: `simulateWeek` の演算の範囲を確かめて確定する。
5. **用語集・イベント一覧の生成方式**: Scala 3 の注釈、`enum` のメタ情報、scaladoc の走査、手書き + テストによる整合の検査の比較（ADR-001 の 018）。
6. **純粋性の検査**: Scalafix の `DisableSyntax.regex` と、`domain` の依存の制限で足りるか（SD5）。
7. **法則のテストの道具**: cats-laws + discipline-munit か、ガイドの全パターンの列挙か（[技術スタック](./tech-stack.md) の ST5）。
8. **`opaque type` と WartRemover・Scalafix の相性**: 断片では問題なかったが、大きなコードでの確認は B1。
9. **Kotlin 版の未決事項の引き継ぎ**: 開始後の共同担当の追加と開始後の参加、遅延 0 を許すか、需要の上限、キット準拠の既定の需要系列（JSD の値の確認）、保持の開始の起点、AC1.2.5 の文言の改訂、観察者への入力済みの役割の開示、`InvalidTransition` の通知先、再構築とコマンドの同時実行制御、`WeekCommitted.contributors` の意味。いずれも [Kotlin 版の未決事項](../beer-game-kotlin/domain-model.md) と同じ扱いで、Kotlin 版の決定に追従する。

10. **開始後の入れ替えの型**（H2）: `Started` の自己遷移（`RoleAssigned`・`ParticipantReplaced` と観察者・資格のイベント）と `RoleHolderReplaced`、`assignRoleAfterStart` の戻り値（`StartDecision` と同じ形か）を B1 で型検査する。1 人だけ外す案・終了後の扱い・イベント名は Kotlin 版のゲート 3.5 に追従する。
11. **`handle` の引数の順**: 本書は `handle(state, command)`（Kotlin 版の `decide` と同じ）、ガイド §7.6 は `handle(command, state)`。B1 で揃えるか決める。
12. **EV-S07 `AutoCommitChanged` と EV-S10 `CommitModeChanged` の重複**（再レビュー M20。前回の M5 が、Scala 版のどの未決事項にも載っていなかった）: Kotlin 版の設計書の表（776・780 行）に並ぶが、Kotlin 版のコード（`SessionEvolve.kt`）の `SessionEvent` には `CommitModeChanged` だけがある。Scala 版の表は `CommitModeChanged` を採る案。イベント名はペイロードの JSON と投影の契約になるため、**Kotlin 版の正本の整理に追従する**（Scala 版で独自に決めない）。
13. **「許す組の表」の確認**（N-H1。再々レビュー R-H3・L11 で、読んで確認できた分を閉じた）: **閉じた**（Kotlin 版のコードを読んで確認した）: `revoked`・`reissued`・`recovered` は未知の主体で状態を変えない（失効の有無の条件も）、`invited`・`invitationRevoked`・`observerJoined` の条件、`withRole`（`RoleAssigned`・`ParticipantReplaced`）は未知の参加者で変えない、`SetCommitMode` は停止中も受け付ける、`EndReason` は `FINAL_WEEK` だけ。**残る未確認**: (1) 表は AI が導いた案で、人の確認を得ていない。(2) 表と `apply` を型検査していない（B1 の最初のスライドで、(a)(b)(c) の 3 方向のテストで確かめる）。(3) `decideInvite` が招待 ID の重複を検査しない前提（ID は生成器が作る）。(4) `startGame` と全コマンドが (a) の生成器で網羅されるか（(b) の `collect` で確かめる）。
14. **`session_overview.week` が最終週 + 1 になる問題**（再レビュー M20。前回の M8）: [データモデル](./data-model.md) の未決事項 7 に載せた（`WeekCommitted` のペイロードに次の週を持たせる案はドメインのイベントの構造に影響するため、ここでも決める）。
15. **ユーザーストーリー・受入条件への導線**（再レビュー M20。前回の M7）: 下の導線の表は、本書に書いた範囲だけの一部。全体は、Unit 定義の `@AC` タグから機械的に導く（[ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md) の許可リスト。別の担当）。
16. **Kotlin 版の潜在不具合: 失効済みの旧担当者への `CredentialRevoked`**（再々レビュー R-H3 (d)。**正本側の整理が要る**）: Kotlin 版の `ReplaceDecision.kt`（`assignRoleAfterStart`）は、旧担当者の全員に `CredentialRevoked` を出し、`GameData.revoked()` は失効済みで `null` を返す。このため、失効済みの旧担当者がいる入れ替えで、`replayGame` が `InvalidTransition` を記録する（`ReplaceRoleSpec.kt` にこの組のテストがない）。Scala 版は D3（未失効にだけ出す）で避ける。**Kotlin 版・Rust 版の側で直すかは、各版の正本の判断**（Scala 版は変えない）。Scala 版の `Ignored` で止める設計（H3）は、同じ穴を Kotlin 版より早く、500 として表に出す。D3 は、ユーザーの指示に基づき AI が推奨案で決めた（確認は未了）。

### ユーザーストーリー・受入条件への導線（一部）

| 本書の規則 | US・AC・UC | 確かめる場所 |
| :--- | :--- | :--- |
| 設定の誤りを全件返す（`ValidatedNec`） | AC1.1.2、AC1.1.4 | 設定の検証の単体テスト |
| 開始後の役割の入れ替え（`assignRoleAfterStart`） | AC3.2.5（共有の `credentials.feature` の `@AC3.2.5`） | 入れ替えの受入テスト（上の 1・3） |
| 開始後の復帰（`ParticipationRecovered`） | US3.2 | 上の受入テスト 4 |
| 停止 → 代理入力 → 再開 | UC-09 | 上の受入テスト 2 |

## レビュー対応の記録（2026-11-25）

[設計書レビュー](../../review/beer-game-scala/design_review_20261125.md) への対応のうち、本書に関するもの（行番号は編集で動くため、節名で記録します）。**H3 の「止める」設計だけがユーザーの決定で、他の直し方は AI の案で、承認を得ていません。**

| 指摘 | 直した箇所 | 状況 |
| :--- | :--- | :--- |
| H2 | 「Game 集約（準備）」の `GameEvent`・`GameEvents.apply`、新設の「開始後の役割の入れ替えと `Started` の自己遷移」、「Session 集約」の状態遷移 | AI の案。再コンパイルしていない |
| H3 | 「beer-game-kotlin からの変更」の 10、「Session 集約」の `Ignored` の扱い | 止める設計はユーザーの決定。運用は architecture-backend |
| H1 | 「本書の位置づけと確認の範囲」を [確認状況の一覧](./tech-stack.md#確認状況の一覧) への参照に | AI の案 |
| L4 | 「設計の前提と原則」のガイドの節（§4.4 を §4.3 に）、「戦略的設計」の `handle` の引数の順の注記 | 直した |
| L6 | `Game.handle` の `AssignRole`（権限が先。`isFacilitator`）、変更表の 12 | AI の案。再コンパイルしていない |

### 再レビュー（[設計書の再レビュー](../../review/beer-game-scala/design_rereview_20261125.md)）への対応

**ユーザー本人が選んだ決定は、前回の H3・H6・H7・H9 と、再レビューの N-H4・N-H6・N-H7・N-H8 の 8 件（ほかにローカル DB の H2 の 1 件）**です。再々レビューの D1〜D5 は、ユーザーの指示に基づき AI が推奨案で決めたもの（確認は未了）で、ユーザーの決定ではありません。**N-H1・N-H2・N-H3・N-H5 の直し方は AI の案で、承認を得ていません。**

| 指摘 | 直した箇所 | 状況 |
| :--- | :--- | :--- |
| N-H1 | `GameEvent` の 12 個、`GameEvents.apply` の腕（`Started` に観察者・資格・復帰を足し、未知の参加者を `Ignored`）、新設の「遷移の許す組の表」（EV-G01〜G12・EV-S01〜S10 × 状態。規範）、入れ替えの節の受入テストの要件（停止中の入れ替え → 代理入力 → 再開、再開後は新担当者だけが保存）、状態遷移図、変更表の 11・13 | AI の案。表は Kotlin 版のコード（`Game.kt`・`SessionEvolve.kt`）と図を読んで導いた。再コンパイルしていない |
| N-H5 | 「本書の位置づけと確認の範囲」に正本の規則（一覧が正。根拠は実測の記録。一覧を直すときは根拠も直す） | AI の案 |
| M16 | 「SD1〜SD7」の冒頭（SD2 の「止める」はユーザーの決定、ほかは案） | 直した |
| M20 | 未決事項の 12（EV-S07 と EV-S10 の重複）〜15、ユーザーストーリー・受入条件への導線（一部）の表、変更表の 14 | 直した（導線は一部。全体は ADR-001 の許可リスト側） |
| N-H8 | 本書では扱わない（ADR-001 と運用の別の担当）。ドメインの規則には影響しない | - |

### 再々レビュー（[設計書の再々レビュー](../../review/beer-game-scala/design_rereview2_20261125.md)）への対応

**ユーザーの決定は、前回までの H3・H6・H7・H9・N-H4・N-H6・N-H7・N-H8 の 8 件と、ローカル DB（H2）の 1 件**です。**D1〜D5 は、ユーザーの「決定を行い、高 10 件を設計書に反映」という指示に基づき、AI が推奨案で決めたもの（2026-11-25。ユーザー本人が選択肢を選んだ決定ではなく、確認は未了）**です。それ以外の直し方は AI の案で、承認を得ていません。

| 指摘 | 直した箇所 | 状況 |
| :--- | :--- | :--- |
| R-H3 | 「許す組の表」の session の表を全行 7 列に（EV-S06・S09・S10 の `Ended` の列）、EV-S04 の `Paused` を ×、規則の文言（`handle`・`startGame`・`assignRoleAfterStart` が作る組）、Kotlin 版のコードで確かめた条件を game の表の備考に、`GameData` と `GameEvents.apply` の条件つきの腕（6 イベントを条件なしの `Applied` にしていた箇所）、`SessionEvents.apply` のスケッチ、D3（`replacementEvents`。失効済みの旧担当者には `CredentialRevoked` を出さない）、受入テスト 5（失効 → 入れ替え → 保存・確定 → 再生）、未決事項 13 の縮小（L11）と 16（Kotlin 版の潜在不具合）、変更表 15・16 | D3 はユーザーの指示に基づき AI が推奨案で決めた（確認は未了）。表と条件は Kotlin 版のコードを読んで確認。Scala のコードは型検査していない |
| R-H4 | 「表の使い方」を、コマンドから作る 3 方向（(a) `Ignored` が 0 件、(b) 表の ○ が N 回以上現れる、(c) 表 × `apply` の全組）に。表は 1 か所の値から生成するか、Markdown の表を読んで突き合わせる。合格の基準（○ を × にすると (a) が落ちる、腕を消すと (c) が落ちる） | AI の案。B1 で実装して確かめる |

## 出典

- 型の断片の検査: sbt 1.13.1（JetBrains Runtime 25.0.4.1）、Scala 3.7.4、cats-core 2.13.0、munit 1.3.6、WartRemover 3.6.3、2026-11-25
- [ドメインモデル設計（beer-game-kotlin）](../beer-game-kotlin/domain-model.md)、[ドメインモデル設計（Rust 版）](../beer-game-rust/domain-model.md)
- [ADR-001（Scala 版）](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md)、[技術スタック（Scala 版）](./tech-stack.md)
- [関数型プログラミングガイド（Scala 編）](../../reference/関数型プログラミングガイド_Scala編.md) 第 1〜3 章、第 6 章、§7.3〜§7.6、第 8・9 章
- [要件定義](../../requirements/beer-game-ts/requirements_definition.md)、[システムユースケース](../../requirements/beer-game-ts/system_usecase.md)、[ユーザーストーリー](../../requirements/beer-game-ts/user_story.md)
