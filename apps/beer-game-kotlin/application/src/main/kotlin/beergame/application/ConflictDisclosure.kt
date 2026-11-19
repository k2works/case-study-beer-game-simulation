package beergame.application

import arrow.core.Either
import beergame.domain.Actor
import beergame.domain.DomainError
import beergame.domain.Editor
import beergame.domain.GameId
import beergame.domain.SessionError

/**
 * 競合の失敗（入力の競合・確定の根拠の変化）に添える、最新の入力の詳細（B6）。
 * 投影から作り、呼び出した人ごとの開示の規則を掛ける純粋関数（保存者の表示名の結合は [Disclosure.editorView]）。
 */
object ConflictDisclosure {
    /**
     * [actor] は競合した人（参加者の保存か、進行役の確定）。競合した人自身の入力は含めない（投影の最新の入力だけ）。
     * 表示名は、保存の競合では同じ役割の共同担当（保存できるのは同じ役割だけ）、確定の競合では進行役にだけ返す。
     * 競合でない失敗、最新の入力がまだ無いときは null。
     */
    fun conflictDetail(
        game: ProjectedGame,
        error: DomainError,
        actor: Actor,
    ): ConflictDetail? {
        val isSelf = isSelfOf(actor)
        return when (error) {
            is SessionError.DecisionConflict -> {
                ConflictDetail.Latest(game.decisions[error.role]?.let { detailOf(game, it, isSelf) })
            }

            is SessionError.DecisionsChanged -> {
                ConflictDetail.Current(game.decisions.mapValues { (_, decision) -> detailOf(game, decision, isSelf) })
            }

            else -> {
                null
            }
        }
    }

    private fun isSelfOf(actor: Actor): (Editor) -> Boolean =
        when (actor) {
            is Actor.Participant -> { editor -> editor is Editor.ByParticipant && editor.id == actor.id }
            else -> { editor -> editor is Editor.ByFacilitator }
        }

    private fun detailOf(
        game: ProjectedGame,
        decision: ProjectedDecision,
        isSelf: (Editor) -> Boolean,
    ): DecisionDetail =
        DecisionDetail(
            decision.quantity,
            decision.version,
            Disclosure.editorView(game, decision.editor, isSelf),
            decision.savedAt,
        )
}

/**
 * 入力の競合・確定の根拠の変化（業務上の失敗）に、最新の入力の詳細（保存者・保存の時刻）を添える（B6）。
 * 失敗した後に、投影を 1 回読む（トランザクションの外。投影は追記と同じトランザクションで書かれるので、競合の相手の入力まで反映済み）。
 * 読めない・無いときは、詳細なしで失敗を返す（失敗の種類は変えない）。
 */
internal suspend fun Either<AppFailure, CommandOutcome>.withConflictDetail(
    ports: Ports,
    gameId: GameId,
    actor: Actor,
): Either<AppFailure, CommandOutcome> =
    when (this) {
        is Either.Right -> {
            this
        }

        is Either.Left -> {
            val failure = value
            if (failure is AppFailure.Domain && failure.detail == null) {
                val detail =
                    ports.reader
                        .read(gameId)
                        .getOrNull()
                        ?.let { ConflictDisclosure.conflictDetail(it, failure.error, actor) }
                Either.Left(failure.copy(detail = detail))
            } else {
                this
            }
        }
    }
