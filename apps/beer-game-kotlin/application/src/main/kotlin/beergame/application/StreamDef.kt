package beergame.application

import arrow.core.Either
import arrow.core.left
import arrow.core.raise.either
import arrow.core.right
import beergame.domain.Command
import beergame.domain.DomainError
import beergame.domain.DomainEvent
import beergame.domain.EventEnvelope
import beergame.domain.Evolve
import beergame.domain.GameCommand
import beergame.domain.GameEvent
import beergame.domain.GameId
import beergame.domain.GameState
import beergame.domain.SessionCommand
import beergame.domain.SessionEvent
import beergame.domain.SessionState
import beergame.domain.StartGame
import beergame.domain.StreamType
import beergame.domain.StreamVersion
import beergame.domain.decideGame
import beergame.domain.decideSession
import beergame.domain.evolveGame
import beergame.domain.evolveSession
import beergame.domain.startGame as decideStart

/*
 * 1 本または 2 本のストリームへのコマンド。「読み込み → 再生 → decide → 追記 → 投影 → 周辺ストア → 通知」。
 * 順序と配線だけを持ち、業務ルールは decide（domain）にある。
 */

/** 1 本のストリームの、`decide` と `evolve` と、封筒の中身の取り出し（別の種類が混ざったら null）。 */
internal class StreamDef<S, E : DomainEvent, C : Command>(
    val type: StreamType,
    val initial: S,
    val evolve: Evolve<S, E>,
    val decide: (S, C) -> Either<DomainError, List<E>>,
    val unwrap: (DomainEvent) -> E?,
)

internal val gameStream: StreamDef<GameState, GameEvent, GameCommand> =
    StreamDef(StreamType.GAME, GameState.NotCreated, ::evolveGame, ::decideGame) { it as? GameEvent }

internal val sessionStream: StreamDef<SessionState, SessionEvent, SessionCommand> =
    StreamDef(StreamType.SESSION, SessionState.NotStarted, ::evolveSession, ::decideSession) { it as? SessionEvent }

private fun <S, E : DomainEvent, C : Command> StreamDef<S, E, C>.replay(read: StreamRead): Either<AppFailure, S> {
    val typed = read.events.map { unwrap(it.payload) }
    return if (typed.any { it == null }) {
        AppFailure.Persistence(PersistenceFailure("events.replay", "ストリームに別の種類のイベントがある: $type")).left()
    } else {
        typed.filterNotNull().fold(initial, evolve).right()
    }
}

/**
 * 1 本のストリームへのコマンド。`decide` が空の列を返したときは、追記も投影もせず、現在の版を返す
 * （冪等記録だけが書かれる）。[sideWrites] は、追記したときだけ呼び、同じトランザクションで書く周辺ストアの行を導く。
 */
internal suspend fun <S, E : DomainEvent, C : Command> Ports.applySingle(
    tx: Tx,
    ctx: Ctx,
    stream: StreamDef<S, E, C>,
    command: C,
    sideWrites: () -> List<PeripheralWrite> = { emptyList() },
): Either<AppFailure, Versions> =
    either {
        val read = events.read(tx, ctx.gameId, stream.type).bind()
        val state = stream.replay(read).bind()
        val decided = stream.decide(state, command).mapLeft(AppFailure::Domain).bind()
        if (decided.isEmpty()) {
            versionsOf(listOf(stream.type to read.version))
        } else {
            val newEvents = decided.map { newEvent(stream.type, it, ctx) }
            val envelopes = events.append(tx, mapOf(stream.type to read.version), newEvents).bind()
            writeSideEffects(tx, ctx.gameId, envelopes, sideWrites()).bind()
            versionsOf(envelopes.map { it.streamType to it.streamVersion })
        }
    }

/** ゲームの開始。`game` と `session` の両方を読み、`startGame` の結果を、両方の期待する版で 1 回の追記で書く。 */
internal suspend fun Ports.applyStart(
    tx: Tx,
    ctx: Ctx,
    command: StartGame,
): Either<AppFailure, Versions> =
    either {
        val gameRead = events.read(tx, ctx.gameId, StreamType.GAME).bind()
        val sessionRead = events.read(tx, ctx.gameId, StreamType.SESSION).bind()
        val game = gameStream.replay(gameRead).bind()
        val session = sessionStream.replay(sessionRead).bind()
        val decision = decideStart(game, session, command).mapLeft(AppFailure::Domain).bind()
        val newEvents =
            decision.game.map { newEvent(StreamType.GAME, it, ctx) } +
                decision.session.map { newEvent(StreamType.SESSION, it, ctx) }
        val expected = mapOf(StreamType.GAME to gameRead.version, StreamType.SESSION to sessionRead.version)
        val envelopes = events.append(tx, expected, newEvents).bind()
        writeSideEffects(tx, ctx.gameId, envelopes, emptyList()).bind()
        versionsOf(envelopes.map { it.streamType to it.streamVersion })
    }

private suspend fun Ports.newEvent(
    stream: StreamType,
    payload: DomainEvent,
    ctx: Ctx,
): NewEvent =
    NewEvent(newId(), ctx.gameId, stream, payload, ctx.actor.toRef(), ctx.correlationId, ctx.commandId, ctx.at)

/** 追記の後に、同じトランザクションで書くもの: 投影、周辺ストア、版の通知（コミットされたときだけ配信される）。 */
private suspend fun Ports.writeSideEffects(
    tx: Tx,
    gameId: GameId,
    envelopes: List<EventEnvelope<DomainEvent>>,
    writes: List<PeripheralWrite>,
): Either<AppFailure, Unit> =
    either {
        project.write(tx, gameId, envelopes).bind()
        if (writes.isNotEmpty()) peripheral.write(tx, writes).bind()
        notifier.publish(tx, noticesOf(gameId, envelopes)).mapLeft(AppFailure::Persistence).bind()
    }

private fun noticesOf(
    gameId: GameId,
    envelopes: List<EventEnvelope<DomainEvent>>,
): List<VersionNotice> =
    envelopes
        .groupBy { it.streamType }
        .map { (stream, list) -> VersionNotice(gameId, stream, list.last().streamVersion) }

private fun versionsOf(versions: List<Pair<StreamType, StreamVersion>>): Versions =
    Versions(
        game = versions.lastOrNull { it.first == StreamType.GAME }?.second,
        session = versions.lastOrNull { it.first == StreamType.SESSION }?.second,
    )
