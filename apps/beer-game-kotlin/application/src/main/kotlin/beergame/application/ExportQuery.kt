package beergame.application

import arrow.core.Either
import arrow.core.raise.either
import arrow.core.raise.ensure
import arrow.core.raise.ensureNotNull
import beergame.domain.Actor
import beergame.domain.ExportDocument
import beergame.domain.ExportFormat
import beergame.domain.ExportPackage
import beergame.domain.ExportRow
import beergame.domain.ExportSettings
import beergame.domain.GameError
import beergame.domain.GameId
import beergame.domain.buildExport

/**
 * 結果の出力（`GET /games/{id}/exports`。B10。US4.3）。**進行役だけ**が、終了後に、全週・全役割の記録を CSV か JSON で受け取る。
 * 参加者・観察者・無資格・別のゲーム・存在しないゲームは、区別せず [AppFailure.Unauthorized]（存在を明かさない）。
 * 終了前は `game.not_ended`（本文を持たない）。
 *
 * 出力は、投影にせず、要求時に [buildExport]（全域の純粋関数）で作る。最終週までの全週・全役割の記録がそろっていなければ、
 * 部分的な結果を完全な出力として返さず、失敗にする（AC4.3.3。500 `app.internal`。ログにだけ理由が残る）。
 */
suspend fun Ports.export(
    gameId: GameId,
    credential: String?,
    format: ExportFormat,
): Either<AppFailure, ExportDocument> =
    either {
        val at = now()
        val verified = events.transaction { tx -> verifiedSession(tx, credential, at) }.bind()
        ensure(verified.gameId == gameId) { AppFailure.Unauthorized }
        ensure(verified.actor is Actor.Facilitator) { AppFailure.Unauthorized }
        val game = ensureNotNull(reader.read(gameId).bind()) { AppFailure.Unauthorized }
        ensure(game.status == GameStatus.ENDED) { AppFailure.Domain(GameError.NotEnded) }
        val export = game.toExport()
        ensure(export.complete) {
            AppFailure.Persistence(
                PersistenceFailure("export.incomplete", "出力の記録がそろっていない: ${export.rows.size} 件（最終週 ${game.finalWeek}）"),
            )
        }
        export.document(format)
    }

/** 投影の行から、出力の元データを作る（表示名・参加コード・資格は、元の型に無い）。 */
private fun ProjectedGame.toExport(): ExportPackage =
    buildExport(
        ExportSettings(gameId, finalWeek, settings.kind, settings.changes, settings.commitMode),
        results.map {
            ExportRow(
                it.week,
                it.role,
                it.orders,
                it.shipped,
                it.ordered,
                it.endingInventory,
                it.endingBacklog,
                it.weeklyCostMinor,
                it.cumulativeCostMinor,
            )
        },
    )
