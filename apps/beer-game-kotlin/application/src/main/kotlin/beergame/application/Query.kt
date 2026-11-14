package beergame.application

import arrow.core.Either
import arrow.core.raise.either
import arrow.core.raise.ensure
import arrow.core.raise.ensureNotNull
import beergame.domain.Actor
import beergame.domain.GameId
import beergame.domain.Role

/**
 * スナップショット（`GET state` 相当）。認証し、投影から（読み取り専用のトランザクションで）読み、呼び出した人ごとの開示の規則を掛ける。
 * 資格が無効、別のゲーム、存在しないゲームは、区別せず [AppFailure.Unauthorized]（存在を明かさない）。
 * [requestedRole] を指定して、自分の役割と違えば、値を返さず `game.forbidden`（AC2.1.2。経路への写像は Step 9 で決める）。
 */
suspend fun Ports.snapshot(
    gameId: GameId,
    credential: String?,
    requestedRole: Role? = null,
): Either<AppFailure, Snapshot> =
    either {
        val raw = ensureNotNull(credential) { AppFailure.Unauthorized }
        val at = now()
        val digest = CredentialDigest.of(settings.credentialSecret, raw)
        val verified = events.transaction { tx -> peripheral.authenticate(tx, digest, at) }.bind()
        ensureNotNull(verified) { AppFailure.Unauthorized }
        ensure(verified.gameId == gameId) { AppFailure.Unauthorized }
        val game = ensureNotNull(reader.read(gameId).bind()) { AppFailure.Unauthorized }
        when (val actor = verified.actor) {
            is Actor.Facilitator -> {
                Disclosure.forFacilitator(game)
            }

            is Actor.Participant -> {
                Disclosure
                    .forParticipant(
                        game,
                        actor.id,
                        requestedRole,
                    ).mapLeft(AppFailure::Domain)
                    .bind()
            }

            is Actor.Anonymous -> {
                raise(AppFailure.Unauthorized)
            }
        }
    }
