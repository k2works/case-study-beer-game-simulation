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
import arrow.core.toNonEmptyListOrNull
import java.time.Instant

/*
 * Game 集約（準備。ストリーム `game`）。B1 の範囲: 作成、参加、役割の割り当て、開始（startGame が GameStarted を作る）。
 * B5 の範囲: 資格の失効・再発行・復帰（規則は Credential.kt）。観察者・単独の解除（UnassignRole）は後続の Bolt。
 */

/** 確定方式。手動（進行役が確定する）か、自動（4 役割の入力がそろったら、同じ追記で確定する。B8）。 */
enum class CommitMode {
    MANUAL,
    AUTO,
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
    val initial: InitialConditions = KitPreset.initialConditions,
    val delays: Delays = KitPreset.delays,
    val disclosure: DisclosurePolicy = DisclosurePolicy.TEAM_TOTAL,
) {
    fun simulation(): SimulationSettings = SimulationSettings(finalWeek, demand, costPolicy)

    /** 設定の種別。キットの値と違う項目があればカスタム（値から導出する）。 */
    fun kind(): SettingsKind = changedFields().let { if (it.isEmpty()) SettingsKind.Kit else SettingsKind.Custom(it) }

    companion object {
        /**
         * カスタム条件の設定（AC1.1.3・AC1.1.4）。最終週・需要系列の誤りと、条件の誤りを、すべて集めて返す。
         * 条件の指定が無い項目はキットの値で、すべてキットの値なら [kit] と同じ設定になる。
         */
        fun custom(
            finalWeek: Int,
            demand: List<Int>,
            inputs: ConditionInputs,
            commitMode: CommitMode = CommitMode.MANUAL,
        ): Either<NonEmptyList<ValidationError>, GameSettings> {
            val base = kit(finalWeek, demand, commitMode)
            val conditions = inputs.validate()
            return if (base is Either.Right && conditions is Either.Right) {
                val c = conditions.value
                base.value
                    .copy(
                        costPolicy = c.costPolicy,
                        initial = c.initial,
                        delays = c.delays,
                        disclosure = c.disclosure,
                    ).right()
            } else {
                val errors = base.leftOrNull().orEmpty() + conditions.leftOrNull().orEmpty()
                checkNotNull(errors.toNonEmptyListOrNull()) { "誤りが無いのに検証が通っていない" }.left()
            }
        }

        /**
         * キット準拠の設定を、入力の形（最終週 1〜50、需要系列の各週 0〜1000 で長さは最終週以上）を検証して作る。
         * 誤りは項目ごとにすべて集める（最終週の誤りがあっても、需要系列の各週の誤りも返す）。AC1.1.2。
         */
        fun kit(
            finalWeek: Int,
            demand: List<Int>,
            commitMode: CommitMode = CommitMode.MANUAL,
        ): Either<NonEmptyList<ValidationError>, GameSettings> {
            val week = Week.of(finalWeek)
            val series = DemandSeries.of(demand, week.getOrElse { Week.FIRST })
            return when (week) {
                is Either.Right -> series.map { GameSettings(week.value, it, KitPreset.costPolicy, commitMode) }
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
    /** 資格の有効性（進行役は作成時、参加者・観察者は参加時に発行。失効・再発行・復帰で変わる）。 */
    val credentials: Map<CredentialSubject, CredentialValidity>,
    /** 観察用の招待（B9）。招待コードの値は持たない（周辺ストアのダイジェストだけ）。 */
    val invitations: Map<InvitationId, InvitationEntry> = emptyMap(),
    /** 観察者と、参加に使った招待（B9）。観察者は役割を持たない。 */
    val observers: Map<ObserverId, InvitationId> = emptyMap(),
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

    /** 進行役が、観察用の招待を発行する（AC1.3.1）。招待コードの値は境界が作る（ここには持たない）。 */
    data class InviteObserver(
        override val actor: Actor,
        override val at: Instant,
        val invitationId: InvitationId,
        val expiresAt: Instant,
    ) : GameCommand

    /** 進行役が、観察用の招待を失効させる（AC1.3.4）。すでに参加した観察者は影響を受けない。 */
    data class RevokeObserverInvitation(
        override val actor: Actor,
        override val at: Instant,
        val invitationId: InvitationId,
    ) : GameCommand

    /** 観察用の招待で、観察者として参加する。表示名は周辺ストアへ書くための値で、イベントには写さない。 */
    data class JoinAsObserver(
        override val actor: Actor,
        override val at: Instant,
        val observerId: ObserverId,
        val invitationId: InvitationId,
        val displayName: DisplayName,
        val credentialExpiresAt: Instant,
    ) : GameCommand

    /** 進行役が、参加者の資格を失効させる（漏れた資格の被害を止める。AC3.2.5）。準備中と開始後の両方で受け付ける。 */
    @Term("資格の失効", "進行役が、漏れた参加者の資格を使えなくすること。失効した資格での要求は、以前に成功したものの再送でも拒否する", "AC3.2.5、ADR-004")
    data class RevokeCredential(
        override val actor: Actor,
        override val at: Instant,
        val subject: CredentialSubject,
    ) : GameCommand

    /** 進行役が、失効した参加者の資格を、新しい有効期限で再発行する。資格の値（復帰コード）は境界が作る。 */
    @Term("資格の再発行", "失効した参加者の資格に代わる、新しい復帰資格（復帰コード）を進行役が発行すること。値は発行時の応答だけが運び、再表示しない", "AC3.2.5、ADR-015")
    data class ReissueCredential(
        override val actor: Actor,
        override val at: Instant,
        val subject: CredentialSubject,
        val expiresAt: Instant,
    ) : GameCommand

    /** 有効な復帰資格の持ち主（[actor] は [subject] 自身）が復帰する。復帰資格の期限を [credentialExpiresAt] へ更新する。 */
    @Term("復帰", "切断や再起動のあとに、有効な復帰資格で、同じゲーム・同じ役割へ戻ること。新しいブラウザセッションを発行し、復帰資格の期限を新しくする", "AC3.2.1、AC3.2.4")
    data class RecoverParticipation(
        override val actor: Actor,
        override val at: Instant,
        val subject: CredentialSubject,
        val credentialExpiresAt: Instant,
    ) : GameCommand
}

sealed interface GameEvent : DomainEvent {
    @EventSpec("EV-G01", "CreateGame。ストリームが空")
    data class GameCreated(
        val gameId: GameId,
        val joinCode: JoinCode,
        val settings: GameSettings,
        val retentionDays: RetentionDays,
        val facilitatorCredentialExpiresAt: Instant,
    ) : GameEvent

    @EventSpec("EV-G02", "JoinGame。準備中")
    data class ParticipantJoined(
        val participantId: ParticipantId,
        val credentialExpiresAt: Instant,
    ) : GameEvent

    @EventSpec("EV-G03", "AssignRole。進行役、役割が変わる（準備中。開始後は入れ替えの新担当者）")
    data class RoleAssigned(
        val participantId: ParticipantId,
        val role: Role,
    ) : GameEvent

    /** 解除前の役割。付け替えの解除の側（単独の UnassignRole は B1 の範囲外）。 */
    @EventSpec("EV-G04", "AssignRole による付け替え（解除の側）。単独の UnassignRole は未実装")
    data class RoleUnassigned(
        val participantId: ParticipantId,
        val role: Role,
    ) : GameEvent

    @EventSpec("EV-G11", "StartGame。進行役、準備中、各役割に 1 人以上")
    data class GameStarted(
        val gameId: GameId,
    ) : GameEvent

    /** 資格を失効させた。資格の値・表示名は含めない（ADR-002）。 */
    @EventSpec("EV-G08", "RevokeCredential。進行役、失効していない参加者の資格（期限切れでも可）")
    data class CredentialRevoked(
        val subject: CredentialSubject,
    ) : GameEvent

    /** 失効した資格を再発行した。新しい有効期限だけを持つ（資格の値は周辺ストアへ、同じトランザクションで書く）。 */
    @EventSpec("EV-G09", "ReissueCredential。進行役、失効した参加者の資格")
    data class CredentialReissued(
        val subject: CredentialSubject,
        val expiresAt: Instant,
    ) : GameEvent

    /** 復帰した。復帰資格の期限を更新した新しい期限を持つ。 */
    @EventSpec("EV-G10", "RecoverParticipation。有効な復帰資格の持ち主")
    data class ParticipationRecovered(
        val subject: CredentialSubject,
        val credentialExpiresAt: Instant,
    ) : GameEvent

    @EventSpec("EV-G05", "InviteObserver。進行役。準備中と開始後")
    data class ObserverInvited(
        val invitationId: InvitationId,
        val expiresAt: Instant,
    ) : GameEvent

    @EventSpec("EV-G06", "RevokeObserverInvitation。進行役、失効していない招待（期限切れでも可）")
    data class ObserverInvitationRevoked(
        val invitationId: InvitationId,
    ) : GameEvent

    /** 観察者が参加した。表示名と資格の値は含めない（周辺ストアへ、同じトランザクションで書く）。 */
    @EventSpec("EV-G07", "JoinAsObserver。有効で期限内の招待（準備中と開始後）")
    data class ObserverJoined(
        val observerId: ObserverId,
        val invitationId: InvitationId,
        val credentialExpiresAt: Instant,
    ) : GameEvent

    /** 開始後の入れ替えで、旧担当者 [participantId] が [role] から外れ、[replacedBy] が引き継いだ事実（資格の失効は別のイベント）。 */
    @Term("役割の入れ替え", "開始後に、進行役が役割の担当者を別の参加者に替えること。旧担当者の資格は同じ追記で失効し、入力済みの値と週は変わらない", "ドメインモデル 役割の入れ替え、ADR-015")
    @EventSpec("EV-G12", "AssignRole（開始後の入れ替え）。進行役、旧担当者ごとに 1 件。同じ追記で CredentialRevoked と RoleHolderReplaced が付く")
    data class ParticipantReplaced(
        val participantId: ParticipantId,
        val role: Role,
        val replacedBy: ParticipantId,
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

    /** 失効させようとした観察用の招待が、このゲームに無い。 */
    data object InvitationNotFound : GameError {
        override val code: String = "game.invitation_not_found"
        override val category: ErrorCategory = ErrorCategory.NotFound
    }

    /** 終了していない。振り返りは、終了後だけ開示する（AC4.2.2）。 */
    data object NotEnded : GameError {
        override val code: String = "game.not_ended"
        override val category: ErrorCategory = ErrorCategory.InvalidState
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

    /** すでに失効した資格を、もう一度失効させようとした。 */
    data object CredentialAlreadyRevoked : GameError {
        override val code: String = "game.credential_already_revoked"
        override val category: ErrorCategory = ErrorCategory.InvalidState
    }

    /** 失効していない資格を再発行しようとした（有効な資格は置き換えない。先に失効させる）。 */
    data object CredentialNotRevoked : GameError {
        override val code: String = "game.credential_not_revoked"
        override val category: ErrorCategory = ErrorCategory.InvalidState
    }
}

private fun GameState.preparingData(): Either<GameError, GameData> =
    when (this) {
        is GameState.Preparing -> data.right()
        is GameState.NotCreated, is GameState.Started -> GameError.NotPreparing.left()
    }

/** 準備中の割り当て。同じ役割への再割り当ては変化なし（履歴に足さない。D9）、別の役割へは付け替え（2 イベント）。 */
private fun decideAssign(
    state: GameState,
    command: GameCommand.AssignRole,
): Either<GameError, List<GameEvent>> =
    either {
        val data = state.preparingData().bind()
        ensure(command.actor.isFacilitatorOf(data.gameId)) { GameError.Forbidden("割り当ては進行役だけができる") }
        val previous =
            ensureNotNull(data.participants[command.participantId]) {
                GameError.ParticipantNotFound(command.participantId)
            }.role
        when (previous) {
            command.role -> {
                emptyList()
            }

            null -> {
                listOf(GameEvent.RoleAssigned(command.participantId, command.role))
            }

            else -> {
                listOf(
                    GameEvent.RoleUnassigned(command.participantId, previous),
                    GameEvent.RoleAssigned(command.participantId, command.role),
                )
            }
        }
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
                decideAssign(state, command).bind()
            }

            is GameCommand.InviteObserver -> {
                decideInvite(state, command).bind()
            }

            is GameCommand.RevokeObserverInvitation -> {
                decideRevokeInvitation(state, command).bind()
            }

            is GameCommand.JoinAsObserver -> {
                decideJoinAsObserver(state, command).bind()
            }

            is GameCommand.RevokeCredential -> {
                decideRevoke(state, command).bind()
            }

            is GameCommand.ReissueCredential -> {
                decideReissue(state, command).bind()
            }

            is GameCommand.RecoverParticipation -> {
                decideRecover(state, command).bind()
            }
        }
    }

/** 準備中と開始後に、データを更新して版を進める（資格は両方で変わる）。decide が作らない列（null）は、状態を変えずに返す。 */
internal fun GameState.updateData(update: (GameData) -> GameData?): GameState =
    when (this) {
        is GameState.Preparing -> update(data)?.let { GameState.Preparing(it, version.next()) } ?: this
        is GameState.Started -> update(data)?.let { GameState.Started(it, version.next()) } ?: this
        is GameState.NotCreated -> this
    }

/** 未作成だけが、作成で準備中になる（作成者の進行役の資格を発行する）。 */
private fun GameState.created(event: GameEvent.GameCreated): GameState =
    when (this) {
        is GameState.NotCreated -> {
            val facilitator = CredentialSubject.Facilitator(event.gameId)
            val data =
                GameData(event.gameId, event.settings, emptyMap(), emptyMap())
                    .withIssued(facilitator, event.facilitatorCredentialExpiresAt)
            GameState.Preparing(data, version.next())
        }

        is GameState.Preparing, is GameState.Started -> {
            this
        }
    }

/** 開始後のときだけデータを更新して版を進める（役割の入れ替え）。decide が作らない列（更新できない）は、状態を変えずに返す。 */
private fun GameState.updateStarted(update: (GameData) -> GameData?): GameState =
    when (this) {
        is GameState.Started -> update(data)?.let { GameState.Started(it, version.next()) } ?: this
        is GameState.NotCreated, is GameState.Preparing -> this
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
            state.created(event)
        }

        is GameEvent.ParticipantJoined -> {
            state.updatePreparing { data ->
                if (event.participantId in data.participants) {
                    null
                } else {
                    data
                        .copy(participants = data.participants + (event.participantId to ParticipantEntry(null)))
                        .withIssued(CredentialSubject.Participant(event.participantId), event.credentialExpiresAt)
                }
            }
        }

        is GameEvent.RoleAssigned -> {
            // 準備中の割り当てと、開始後の入れ替えの新担当者の両方（開始後の RoleAssigned は assignRoleAfterStart だけが作る）
            state.updateData { it.withRole(event.participantId, event.role) }
        }

        is GameEvent.ParticipantReplaced -> {
            state.updateStarted { it.withRole(event.participantId, null) }
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

        is GameEvent.ObserverInvited -> {
            state.updateData { it.invited(event.invitationId, event.expiresAt) }
        }

        is GameEvent.ObserverInvitationRevoked -> {
            state.updateData { it.invitationRevoked(event.invitationId) }
        }

        is GameEvent.ObserverJoined -> {
            state.updateData { it.observerJoined(event.observerId, event.invitationId, event.credentialExpiresAt) }
        }

        is GameEvent.CredentialRevoked -> {
            state.updateData { it.revoked(event.subject) }
        }

        is GameEvent.CredentialReissued -> {
            state.updateData { it.reissued(event.subject, event.expiresAt) }
        }

        is GameEvent.ParticipationRecovered -> {
            state.updateData { it.recovered(event.subject, event.credentialExpiresAt) }
        }
    }
