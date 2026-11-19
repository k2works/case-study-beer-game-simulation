package beergame.application

import arrow.core.Either
import arrow.core.raise.either
import arrow.core.raise.ensure
import arrow.core.raise.ensureNotNull
import beergame.domain.Actor
import beergame.domain.GameId
import beergame.domain.GuidedTour
import beergame.domain.Role

/**
 * スナップショット（`GET state` 相当）。認証し、投影から（読み取り専用のトランザクションで）読み、呼び出した人ごとの開示の規則を掛ける。
 * 資格が無効、別のゲーム、存在しないゲームは、区別せず [AppFailure.Unauthorized]（存在を明かさない）。
 * [requestedRole] を指定して、自分の役割と違えば、値を返さず `game.forbidden`（AC2.1.2。経路への写像は Step 9 で決める）。
 */
@GuidedTour(
    name = "ウォーキングスケルトン（最初の縦の切片）",
    rank = 7,
    stage = "プレイ",
    description = "進行役と参加者が、状態を表示する。確定した第 2 週の状況と、各役割の第 1 週の結果を、呼び出した人に許された範囲だけ返す",
)
@GuidedTour(
    name = "CQRS（コマンドと問い合わせの分離）",
    rank = 8,
    stage = "問い合わせ側",
    description =
        "認証して投影を読み、呼び出した人ごとの開示の規則を掛けて返す。" +
            "他の役割の値は、返さない",
)
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

            // 観察者は、役割別の値・参加コード・将来の需要を含む状態を取得できない（AC4.1.2）。観察は [observe]
            is Actor.Observer, is Actor.Anonymous -> {
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

/**
 * 観察（`GET /games/{id}/observation`。B9）。観察者と進行役だけが開ける（参加者・無資格・別のゲーム・存在しないゲームは、
 * 区別せず [AppFailure.Unauthorized]。AC4.1.4）。観察者が読める 3 表の行（[ObservationReader]）と、公開範囲・版を使う。
 * 版と公開範囲は、行より先に読む（版は行より新しくならない。画面が通知を捨てて古い表示のまま残るのを防ぐ）。
 */
suspend fun Ports.observe(
    gameId: GameId,
    credential: String?,
): Either<AppFailure, Observation> =
    either {
        val at = now()
        val verified = events.transaction { tx -> verifiedSession(tx, credential, at) }.bind()
        ensure(verified.gameId == gameId) { AppFailure.Unauthorized }
        ensure(verified.actor is Actor.Observer || verified.actor is Actor.Facilitator) { AppFailure.Unauthorized }
        val head = ensureNotNull(reader.read(gameId).bind()) { AppFailure.Unauthorized }
        val rows = ensureNotNull(observation.read(gameId).bind()) { AppFailure.Unauthorized }
        Disclosure.forObservation(gameId, head.disclosure, rows, head.versions)
    }
