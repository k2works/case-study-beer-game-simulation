package beergame.persistence

import arrow.core.Either
import arrow.core.raise.either
import beergame.domain.CommitKind
import beergame.domain.CommitMode
import beergame.domain.DecisionVersion
import beergame.domain.DomainEvent
import beergame.domain.Editor
import beergame.domain.EndReason
import beergame.domain.GameId
import beergame.domain.ParticipantId
import beergame.domain.Pipeline
import beergame.domain.Role
import beergame.domain.RoleState
import beergame.domain.RoleWeekResult
import beergame.domain.SessionEvent

// DTO -> ドメイン（session ストリームのイベントと状態）。値オブジェクトの検証を通す。

private fun RoleStateDto.toState(): Either<String, RoleState> =
    either {
        RoleState(
            units(inventory).bind(),
            units(backlog).bind(),
            Pipeline(orderPipeline.traverse(::units).bind()),
            Pipeline(deliveryPipeline.traverse(::units).bind()),
            money(cumulativeCostMinor).bind(),
            units(arrivals).bind(),
            units(orders).bind(),
        )
    }

private fun RoleWeekResultDto.toResult(): Either<String, RoleWeekResult> =
    either {
        RoleWeekResult(
            units(orders).bind(),
            units(shipped).bind(),
            quantity(ordered).bind(),
            units(endingInventory).bind(),
            units(endingBacklog).bind(),
            money(weeklyCostMinor).bind(),
            money(cumulativeCostMinor).bind(),
        )
    }

internal fun SessionStartedDto.toSessionStarted(): Either<String, DomainEvent> =
    either {
        SessionEvent.SessionStarted(
            GameId(uuid(gameId).bind()),
            settings.toDomain().bind(),
            assignments.traverse { ids -> ids.traverse { uuid(it).map(::ParticipantId) }.map { it.toSet() } }.bind(),
            initialStates.traverse { it.toState() }.bind(),
            enumOf<CommitMode>(commitMode, "確定方式").bind(),
        )
    }

private fun EditorDto.toEditor(): Either<String, Editor> =
    either {
        when (kind) {
            "PARTICIPANT" -> Editor.ByParticipant(ParticipantId(uuid(id).bind()))
            "FACILITATOR" -> Editor.ByFacilitator(GameId(uuid(id).bind()))
            else -> raise("入力者の種別が不正: $kind")
        }
    }

internal fun DecisionSavedDto.toDecisionSaved(): Either<String, DomainEvent> =
    either {
        SessionEvent.DecisionSaved(
            week(week).bind(),
            enumOf<Role>(role, "役割").bind(),
            quantity(quantity).bind(),
            DecisionVersion.of(decisionVersion).mapLeft { it.toString() }.bind(),
            editor.toEditor().bind(),
            submittedRoleCount,
        )
    }

internal fun ProxyDecisionSubmittedDto.toProxyDecisionSubmitted(): Either<String, DomainEvent> =
    either {
        SessionEvent.ProxyDecisionSubmitted(
            week(week).bind(),
            enumOf<Role>(role, "役割").bind(),
            quantity(quantity).bind(),
            DecisionVersion.of(decisionVersion).mapLeft { it.toString() }.bind(),
            editor.toEditor().bind(),
            submittedRoleCount,
        )
    }

internal fun WeekCommittedDto.toWeekCommitted(): Either<String, DomainEvent> =
    either {
        SessionEvent.WeekCommitted(
            week(week).bind(),
            enumOf<CommitKind>(commitKind, "確定の種別").bind(),
            decisions.traverse(::quantity).bind(),
            results.traverse { it.toResult() }.bind(),
            nextStates.traverse { it.toState() }.bind(),
            contributors,
        )
    }

internal fun SessionEndedDto.toSessionEnded(): Either<String, DomainEvent> =
    either { SessionEvent.SessionEnded(enumOf<EndReason>(reason, "終了の理由").bind()) }

internal fun RoleHolderReplacedDto.toRoleHolderReplaced(): Either<String, DomainEvent> =
    either {
        SessionEvent.RoleHolderReplaced(
            enumOf<Role>(role, "役割").bind(),
            removed.traverse { uuid(it).map(::ParticipantId) }.bind().toSet(),
            ParticipantId(uuid(added).bind()),
        )
    }
