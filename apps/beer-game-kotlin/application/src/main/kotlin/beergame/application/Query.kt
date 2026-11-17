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
        val at = now()
        val verified = events.transaction { tx -> verifiedSession(tx, credential, at) }.bind()
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

/**
 * 振り返り（`GET /games/{id}/review`。B4）。進行役と参加者が、終了後に、全役割の全週の結果を取得する。
 * 終了前は `game.not_ended`（開示しない。AC4.2.2）。資格が無効・別のゲーム・存在しないゲームは [AppFailure.Unauthorized]。
 */
suspend fun Ports.review(
    gameId: GameId,
    credential: String?,
): Either<AppFailure, Review> =
    either {
        val at = now()
        val verified = events.transaction { tx -> verifiedSession(tx, credential, at) }.bind()
        ensure(verified.gameId == gameId) { AppFailure.Unauthorized }
        ensure(verified.actor !is Actor.Anonymous) { AppFailure.Unauthorized }
        val game = ensureNotNull(reader.read(gameId).bind()) { AppFailure.Unauthorized }
        Disclosure.forReview(game).mapLeft(AppFailure::Domain).bind()
    }
