package beergame.application

import arrow.core.Either
import arrow.core.NonEmptyList
import arrow.core.left
import arrow.core.mapOrAccumulate
import arrow.core.nonEmptyListOf
import arrow.core.raise.either
import arrow.core.raise.zipOrAccumulate
import arrow.core.right
import beergame.domain.DecisionVersion
import beergame.domain.Quantity
import beergame.domain.Role
import beergame.domain.RoleMap
import beergame.domain.ValidationError
import beergame.domain.Week

/*
 * 入力の形の検証。誤りは項目ごとにすべて集めて返す（AC1.1.2、AC2.2.2）。
 * 値の範囲の規則は、domain の値オブジェクト（スマートコンストラクタ）が持つ。ここは、集める配線だけ。
 */

internal typealias Errors = NonEmptyList<ValidationError>

internal fun <A> Either<ValidationError, A>.nel(): Either<Errors, A> = mapLeft { nonEmptyListOf(it) }

/** 2 つの検証の誤りを、どちらも集めて返す。 */
internal infix fun <A, B> Either<Errors, A>.and(other: Either<Errors, B>): Either<Errors, Pair<A, B>> =
    when (this) {
        is Either.Left -> {
            when (other) {
                is Either.Left -> (value + other.value).left()
                is Either.Right -> this
            }
        }

        is Either.Right -> {
            when (other) {
                is Either.Left -> other
                is Either.Right -> (value to other.value).right()
            }
        }
    }

internal fun validateSave(input: SaveDecisionInput): Either<Errors, Triple<Week, Quantity, DecisionVersion>> =
    either {
        zipOrAccumulate(
            { Week.of(input.week).bind() },
            { Quantity.of(input.quantity).bind() },
            { DecisionVersion.of(input.expectedDecisionVersion).bind() },
        ) { week, quantity, version -> Triple(week, quantity, version) }
    }

internal fun validateProxy(input: ProxyDecisionInput): Either<Errors, Pair<Week, Quantity>> =
    either {
        zipOrAccumulate(
            { Week.of(input.requestedWeek).bind() },
            { Quantity.of(input.quantity).bind() },
        ) { week, quantity -> week to quantity }
    }

internal fun validateCommit(input: CommitWeekInput): Either<Errors, Pair<Week, RoleMap<DecisionVersion>>> =
    Week.of(input.requestedWeek).nel() and
        Role.entries
            .mapOrAccumulate { role -> DecisionVersion.of(input.basis[role]).bind() }
            .map { versions -> Role.entries.zip(versions).toMap() }
            .map { byRole -> RoleMap.of { role -> byRole.getValue(role) } }
