package beergame.domain

import arrow.core.Either
import arrow.core.NonEmptyList
import arrow.core.getOrElse
import arrow.core.left
import arrow.core.nonEmptyListOf
import arrow.core.raise.either
import arrow.core.raise.ensure
import arrow.core.raise.ensureNotNull
import arrow.core.right
import java.time.Instant

/*
 * Game 集約（準備。ストリーム `game`）。B1 の範囲: 作成、参加、役割の割り当て、開始（startGame が GameStarted を作る）。
 * 観察者・資格・単独の解除（UnassignRole）は後続の Bolt。
 */

/** 確定方式。B1 は手動だけ。自動（AUTO）は B8 で足す。 */
enum class CommitMode {
    MANUAL,
}

/**
 * ゲーム設定。B1 はキット準拠（初期条件・遅延・費用方針は [KitPreset] の値）だけを作る。
 * 週次計算に渡す最小の設定は [simulation]。カスタム条件（初期条件・遅延・公開範囲など）は B7。
 */
data class GameSettings(
    val finalWeek: Week,
    val demand: DemandSeries,
    val costPolicy: CostPolicy,
    val commitMode: CommitMode,
) {
    fun simulation(): SimulationSettings = SimulationSettings(finalWeek, demand, costPolicy)

    companion object {
        /**
         * キット準拠の設定を、入力の形（最終週 1〜50、需要系列の各週 0〜1000 で長さは最終週以上）を検証して作る。
         * 誤りは項目ごとにすべて集める（最終週の誤りがあっても、需要系列の各週の誤りも返す）。AC1.1.2。
         */
        fun kit(
            finalWeek: Int,
            demand: List<Int>,
        ): Either<NonEmptyList<ValidationError>, GameSettings> {
            val week = Week.of(finalWeek)
            val series = DemandSeries.of(demand, week.getOrElse { Week.FIRST })
            return when (week) {
                is Either.Right -> series.map { GameSettings(week.value, it, KitPreset.costPolicy, CommitMode.MANUAL) }
                is Either.Left -> nonEmptyListOf<ValidationError>(week.value).plus(series.leftOrNull().orEmpty()).left()
            }
        }
    }
}

data class ParticipantEntry(
    val role: Role?,
)

data class GameData(
    val gameId: GameId,
    val settings: GameSettings,
    val participants: Map<ParticipantId, ParticipantEntry>,
) {
    /** 役割ごとの参加者（開始時に、Session へ写しとして渡す）。 */
    fun roleAssignments(): RoleMap<Set<ParticipantId>> =
        RoleMap.of { role -> participants.filterValues { it.role == role }.keys }

    /** 参加者の役割を変える。未知の参加者なら null（decide が作らない列）。 */
    internal fun withRole(
        participantId: ParticipantId,
        role: Role?,
    ): GameData? =
        participants[participantId]?.let {
            copy(
                participants = participants + (participantId to ParticipantEntry(role)),
            )
        }
}

sealed interface GameState {
    val version: StreamVersion

    /** ストリームが空。 */
    data object NotCreated : GameState {
        override val version: StreamVersion = StreamVersion.ZERO
    }

    /** 参加・割り当てを受け付ける。 */
    data class Preparing(
        val data: GameData,
        override val version: StreamVersion,
    ) : GameState

    /** 設定と割り当てを固定。 */
    data class Started(
        val data: GameData,
        override val version: StreamVersion,
    ) : GameState
}

fun GameState.dataOrNull(): GameData? =
    when (this) {
        is GameState.NotCreated -> null
        is GameState.Preparing -> data
        is GameState.Started -> data
    }

sealed interface GameCommand : Command {
    data class CreateGame(
        override val actor: Actor,
        override val at: Instant,
        val gameId: GameId,
        val joinCode: JoinCode,
        val settings: GameSettings,
        val retentionDays: RetentionDays,
        val facilitatorCredentialExpiresAt: Instant,
    ) : GameCommand

    /** 表示名は周辺ストアへ書くための値で、イベントには写さない（NF-S14）。 */
    data class JoinGame(
        override val actor: Actor,
        override val at: Instant,
        val participantId: ParticipantId,
        val displayName: DisplayName,
        val credentialExpiresAt: Instant,
    ) : GameCommand

    data class AssignRole(
        override val actor: Actor,
        override val at: Instant,
        val participantId: ParticipantId,
        val role: Role,
    ) : GameCommand
}

sealed interface GameEvent : DomainEvent {
    data class GameCreated(
        val gameId: GameId,
        val joinCode: JoinCode,
        val settings: GameSettings,
        val retentionDays: RetentionDays,
        val facilitatorCredentialExpiresAt: Instant,
    ) : GameEvent

    data class ParticipantJoined(
        val participantId: ParticipantId,
        val credentialExpiresAt: Instant,
    ) : GameEvent

    data class RoleAssigned(
        val participantId: ParticipantId,
        val role: Role,
    ) : GameEvent

    /** 解除前の役割。付け替えの解除の側（単独の UnassignRole は B1 の範囲外）。 */
    data class RoleUnassigned(
        val participantId: ParticipantId,
        val role: Role,
    ) : GameEvent

    data class GameStarted(
        val gameId: GameId,
    ) : GameEvent
}

sealed interface GameError : DomainError {
    data object AlreadyCreated : GameError {
        override val code: String = "game.already_created"
        override val category: ErrorCategory = ErrorCategory.InvalidState
    }

    /**
     * 参加コードが無効（不明、または形式が不正）。区別せず、同じ応答にする（列挙の防止。AC1.2.2）。
     * 参加コードからゲームを引くのは境界（Step 8 のアプリケーション層）なので、decide は返さない。
     */
    data object InvitationInvalid : GameError {
        override val code: String = "game.invitation_invalid"
        override val category: ErrorCategory = ErrorCategory.Forbidden
    }

    /** 準備中でない（未作成、または開始済み）。 */
    data object NotPreparing : GameError {
        override val code: String = "game.not_preparing"
        override val category: ErrorCategory = ErrorCategory.InvalidState
    }

    data class Forbidden(
        val reason: String,
    ) : GameError {
        override val code: String = "game.forbidden"
        override val category: ErrorCategory = ErrorCategory.Forbidden
    }

    data class ParticipantNotFound(
        val participantId: ParticipantId,
    ) : GameError {
        override val code: String = "game.participant_not_found"
        override val category: ErrorCategory = ErrorCategory.NotFound
    }

    /** 開始の条件（4 役割のそれぞれに 1 人以上）を満たさない。不足している役割を上流から下流の順に示す（AC1.2.3）。 */
    data class StartConditionNotMet(
        val missing: List<Role>,
    ) : GameError {
        override val code: String = "game.start_condition_not_met"
        override val category: ErrorCategory = ErrorCategory.RuleViolation
    }
}

private fun GameState.preparingData(): Either<GameError, GameData> =
    when (this) {
        is GameState.Preparing -> data.right()
        is GameState.NotCreated, is GameState.Started -> GameError.NotPreparing.left()
    }

/** 作成・参加・役割の割り当ての規則は、すべてここに集まる（evolve は事実を採用するだけで、規則を持たない）。 */
fun decideGame(
    state: GameState,
    command: GameCommand,
): Either<GameError, List<GameEvent>> =
    either {
        when (command) {
            is GameCommand.CreateGame -> {
                ensure(state is GameState.NotCreated) { GameError.AlreadyCreated }
                ensure(command.actor is Actor.Anonymous) { GameError.Forbidden("作成は匿名の操作者だけができる") }
                listOf(
                    GameEvent.GameCreated(
                        command.gameId,
                        command.joinCode,
                        command.settings,
                        command.retentionDays,
                        command.facilitatorCredentialExpiresAt,
                    ),
                )
            }

            is GameCommand.JoinGame -> {
                state.preparingData().bind()
                listOf(GameEvent.ParticipantJoined(command.participantId, command.credentialExpiresAt))
            }

            is GameCommand.AssignRole -> {
                val data = state.preparingData().bind()
                ensure(command.actor.isFacilitatorOf(data.gameId)) { GameError.Forbidden("割り当ては進行役だけができる") }
                val current =
                    ensureNotNull(data.participants[command.participantId]) {
                        GameError.ParticipantNotFound(command.participantId)
                    }
                val previous = current.role
                when {
                    previous == command.role -> {
                        emptyList()
                    }

                    // 変化なし。履歴に足さない（D9）
                    previous == null -> {
                        listOf(GameEvent.RoleAssigned(command.participantId, command.role))
                    }

                    else -> {
                        listOf(
                            GameEvent.RoleUnassigned(command.participantId, previous), // 付け替え = 2 イベント（D9）
                            GameEvent.RoleAssigned(command.participantId, command.role),
                        )
                    }
                }
            }
        }
    }

/** 準備中のときだけデータを更新して版を進める。decide が作らない列（更新できない）は、状態を変えずに返す。 */
private fun GameState.updatePreparing(update: (GameData) -> GameData?): GameState =
    when (this) {
        is GameState.Preparing -> update(data)?.let { GameState.Preparing(it, version.next()) } ?: this
        is GameState.NotCreated, is GameState.Started -> this
    }

/**
 * イベントを状態へ畳み込む。全域（例外を投げない。強制キャストを使わない）。
 * decide が作らない列は、状態を変えずに返す（版も増えない。検知は [replayGame]）。
 */
fun evolveGame(
    state: GameState,
    event: GameEvent,
): GameState =
    when (event) {
        is GameEvent.GameCreated -> {
            when (state) {
                is GameState.NotCreated -> {
                    GameState.Preparing(GameData(event.gameId, event.settings, emptyMap()), state.version.next())
                }

                is GameState.Preparing, is GameState.Started -> {
                    state
                }
            }
        }

        is GameEvent.ParticipantJoined -> {
            state.updatePreparing { data ->
                if (event.participantId in data.participants) {
                    null
                } else {
                    data.copy(participants = data.participants + (event.participantId to ParticipantEntry(null)))
                }
            }
        }

        is GameEvent.RoleAssigned -> {
            state.updatePreparing { it.withRole(event.participantId, event.role) }
        }

        is GameEvent.RoleUnassigned -> {
            state.updatePreparing { it.withRole(event.participantId, null) }
        }

        is GameEvent.GameStarted -> {
            when (state) {
                is GameState.Preparing -> GameState.Started(state.data, state.version.next())
                is GameState.NotCreated, is GameState.Started -> state
            }
        }
    }
