package beergame.domain

import arrow.core.Either
import java.time.Instant
import java.util.UUID

/*
 * 集約に共通の土台。decide / evolve の型、Command・Event・DomainError の基底、操作者、封筒、再生。
 * 時刻・ID・乱数はここでも作らない（コマンドの値で受け取る）。
 */

/** 決定: `(状態, コマンド) -> Either<エラー, イベントの列>`。純粋。 */
typealias Decide<S, C, E, Err> = (S, C) -> Either<Err, List<E>>

/** 進化: `(状態, イベント) -> 状態`。純粋で全域（失敗しない。強制キャストを使わない）。 */
typealias Evolve<S, E> = (S, E) -> S

/** ストリームの種類。1 ゲームにつき `game` と `session` の 2 本。 */
enum class StreamType { GAME, SESSION }

/** エラーの分類。HTTP の状態への写像（アダプターの責務）の入力になる。 */
enum class ErrorCategory { Forbidden, NotFound, InvalidState, Conflict, RuleViolation }

/**
 * 業務ルール違反。安定した [code]（小文字のドット区切り `<領域>.<名前>`）と [category] を持つ。
 * `code` は problem+json の `type` とフロントエンドの辞書の鍵になるので、一度決めたら変えない。
 */
sealed interface DomainError {
    val code: String
    val category: ErrorCategory
}

/** 操作者の種別。 */
enum class ActorKind { FACILITATOR, PARTICIPANT, OBSERVER, ANONYMOUS }

/** 封筒に載せる操作者の参照。種別と ID だけで、表示名を含めない。 */
data class ActorRef(
    val kind: ActorKind,
    val id: UUID?,
)

/** コマンドを発行した主体。認証は境界が行い、結果の [Actor] をコマンドに載せる（B1 の範囲。観察者は B9）。 */
sealed interface Actor {
    data class Facilitator(
        val gameId: GameId,
    ) : Actor

    data class Participant(
        val id: ParticipantId,
    ) : Actor

    /** 観察用の招待で参加した人。役割を持たず、状態を変更できない（B9）。 */
    data class Observer(
        val id: ObserverId,
    ) : Actor

    data object Anonymous : Actor

    fun isFacilitatorOf(gameId: GameId): Boolean = this is Facilitator && this.gameId == gameId

    fun toRef(): ActorRef =
        when (this) {
            is Facilitator -> ActorRef(ActorKind.FACILITATOR, gameId.value)
            is Participant -> ActorRef(ActorKind.PARTICIPANT, id.value)
            is Observer -> ActorRef(ActorKind.OBSERVER, id.value)
            is Anonymous -> ActorRef(ActorKind.ANONYMOUS, null)
        }
}

/** 全コマンドが持つ共通項目。`at` はコマンドが運ぶ時刻（decide は時計を読まない）。 */
sealed interface Command {
    val actor: Actor
    val at: Instant
}

/** 起きた事実。過去形で命名し、変更しない。 */
@GuidedTour(
    name = "イベントソーシング（事実が状態の正本）",
    rank = 2,
    stage = "事実を決める",
    description =
        "起きた事実の型。過去形で命名し、いったん残したら変更しない。" +
            "個人情報と秘密は入れず、識別子と有効期限だけを持つ",
)
sealed interface DomainEvent

/** 全イベントに付く封筒。永続化と追跡に必要な項目を、ペイロードとは別に持つ。 */
@GuidedTour(
    name = "イベントソーシング（事実が状態の正本）",
    rank = 3,
    stage = "事実を決める",
    description =
        "事実に付ける封筒。ストリームの版・書いた版・操作者・相関 ID・時刻を、ペイロードとは別に持つ。" +
            "版が、追記の順序と同時更新の検出の基準になる",
)
data class EventEnvelope<out E : DomainEvent>(
    val eventId: UUID,
    val gameId: GameId,
    val streamType: StreamType,
    val streamVersion: StreamVersion,
    val schemaVersion: Int,
    val actor: ActorRef,
    val correlationId: UUID,
    val commandId: UUID,
    val occurredAt: Instant,
    val payload: E,
)

/** decide が作らない列（例: 未開始への入力の保存）を再生で見つけた記録。状態は変わらない。 */
data class InvalidTransition(
    val streamType: StreamType,
    val stateName: String,
    val eventType: String,
)

/** 再生の結果。再生した状態と、検知した不正な遷移。 */
data class Replayed<S>(
    val state: S,
    val invalid: List<InvalidTransition>,
)

/**
 * イベント列を状態へ畳み込む。有効なイベントは必ず版を 1 増やすので、
 * 前後で版が増えなかったイベントを不正な遷移として記録する。
 */
private fun <S : Any, E : DomainEvent> replay(
    streamType: StreamType,
    initial: S,
    events: List<E>,
    evolve: Evolve<S, E>,
    versionOf: (S) -> StreamVersion,
): Replayed<S> =
    events.fold(Replayed(initial, emptyList())) { acc, event ->
        val next = evolve(acc.state, event)
        if (versionOf(next) == versionOf(acc.state)) {
            val transition =
                InvalidTransition(streamType, acc.state.nameOf(), event.nameOf())
            Replayed(next, acc.invalid + transition)
        } else {
            Replayed(next, acc.invalid)
        }
    }

private fun Any.nameOf(): String = this::class.simpleName ?: "anonymous"

fun replayGame(events: List<GameEvent>): Replayed<GameState> =
    replay(StreamType.GAME, GameState.NotCreated, events, ::evolveGame) { it.version }

@GuidedTour(
    name = "イベントソーシング（事実が状態の正本）",
    rank = 7,
    stage = "状態を取り戻す",
    description = "事実の列を先頭から畳み込んで、現在の状態を取り戻す。decide が作らない列を見つけたら、不正な遷移として記録する",
)
fun replaySession(events: List<SessionEvent>): Replayed<SessionState> =
    replay(StreamType.SESSION, SessionState.NotStarted, events, ::evolveSession) { it.version }
