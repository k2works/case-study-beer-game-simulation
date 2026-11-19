package beergame.persistence

import arrow.core.Either
import arrow.core.raise.either
import beergame.domain.Money
import beergame.domain.Quantity
import beergame.domain.RoleMap
import beergame.domain.Units
import beergame.domain.Week
import java.time.Instant
import java.util.UUID

// DTO の値を、ドメインの値オブジェクトの検証を通して復元する補助。失敗は理由の文字列（Left）。

internal fun uuid(raw: String): Either<String, UUID> =
    Either
        .catch {
            UUID.fromString(raw)
        }.mapLeft { "UUID が不正: $raw" }

internal fun instant(raw: String): Either<String, Instant> =
    Either
        .catch {
            Instant.parse(raw)
        }.mapLeft { "時刻が不正: $raw" }

internal inline fun <reified E : Enum<E>> enumOf(
    raw: String,
    label: String,
): Either<String, E> = Either.catch { enumValueOf<E>(raw) }.mapLeft { "$label が不正: $raw" }

internal fun units(n: Int): Either<String, Units> = Units.of(n).mapLeft { it.toString() }

internal fun money(minor: Long): Either<String, Money> = Money.of(minor).mapLeft { it.toString() }

internal fun week(n: Int): Either<String, Week> = Week.of(n).mapLeft { it.toString() }

internal fun quantity(n: Int): Either<String, Quantity> = Quantity.of(n).mapLeft { it.toString() }

internal fun <A, B> RoleMapDto<A>.traverse(f: (A) -> Either<String, B>): Either<String, RoleMap<B>> =
    either { RoleMap(f(factory).bind(), f(distributor).bind(), f(wholesaler).bind(), f(retailer).bind()) }

internal fun <A, B> List<A>.traverse(f: (A) -> Either<String, B>): Either<String, List<B>> =
    either {
        map { f(it).bind() }
    }
