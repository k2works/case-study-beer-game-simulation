package beergame.application

import beergame.domain.EXPORT_SCHEMA_VERSION
import beergame.domain.ExportFormat
import beergame.domain.Role
import beergame.domain.StreamVersion
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import kotlinx.coroutines.runBlocking

/*
 * 結果の出力（B10。US4.3）。認可（進行役だけ）、終了後だけ、欠けた記録を出力にしない（AC4.3.3）。
 * 出力の中身（列・値・チェックサム）は、domain の ExportSpec が確かめる。ここは、投影からの組み立てと開示の規則。
 */

private const val FINAL_WEEK = 3

private fun result(
    week: Int,
    role: Role,
) = ProjectedWeekResult(week, role, 4, 4, 4, 10 + week, 0, 100L, 100L * week)

private fun World.projectedFor(
    game: Prepared,
    status: GameStatus,
    settings: SettingsSummary = SettingsSummary.KIT,
    results: List<ProjectedWeekResult> = (1..FINAL_WEEK).flatMap { week -> Role.entries.map { result(week, it) } },
) {
    projectedGame =
        ProjectedGame(
            gameId = game.gameId,
            status = status,
            finalWeek = FINAL_WEEK,
            joinCode = game.created.joinCode,
            settings = settings,
            participants = emptyList(),
            session = null,
            roleStates = emptyMap(),
            decisions = emptyMap(),
            results = results,
            versions = Versions(StreamVersion.of(5L).ok(), StreamVersion.of(8L).ok()),
        )
}

private fun World.export(
    game: Prepared,
    credential: String?,
    format: ExportFormat = ExportFormat.CSV,
) = runBlocking { ports.export(game.gameId, credential, format) }

class ExportSpec :
    FunSpec({
        test("[B10/AC4.3.1] Given 終了したゲーム When 進行役が出力する Then 設定・全週・全役割を含む CSV と JSON が、同じスキーマ版で返る") {
            val world = World()
            val game = world.started()
            world.projectedFor(game, GameStatus.ENDED, SettingsSummary("CUSTOM", listOf("INITIAL_INVENTORY"), "AUTO"))

            val csv = world.export(game, game.facilitator, ExportFormat.CSV).ok()
            val json = world.export(game, game.facilitator, ExportFormat.JSON).ok()

            csv.format shouldBe ExportFormat.CSV
            json.format shouldBe ExportFormat.JSON
            csv.body
                .split("\r\n")
                .filter { it.isNotEmpty() }
                .size shouldBe 1 + FINAL_WEEK * Role.entries.size
            csv.body shouldContain "CUSTOM,INITIAL_INVENTORY,AUTO"
            json.body shouldContain "\"schemaVersion\":\"$EXPORT_SCHEMA_VERSION\""
            json.body shouldContain "\"changes\":[\"INITIAL_INVENTORY\"]"
        }

        test("[B10/AC4.3.1] Given 終了前のゲーム When 進行役が出力する Then 値を持たず game.not_ended") {
            val world = World()
            val game = world.started()

            listOf(GameStatus.PREPARING, GameStatus.STARTED).forEach { status ->
                world.projectedFor(game, status)
                world.export(game, game.facilitator).domainCode() shouldBe "game.not_ended"
            }
        }

        test("[B10/AC4.3.1] Given 終了後のゲーム When 参加者・無資格・別のゲームの進行役が出力する Then すべて同じ Unauthorized") {
            val world = World()
            val game = world.started()
            val other = world.started(tag = "other")
            world.projectedFor(game, GameStatus.ENDED)

            listOf(
                world.export(game, game.seats[Role.RETAILER].credential),
                world.export(game, null),
                world.export(game, "v1.no-such-credential"),
                world.export(game, other.facilitator),
            ).forEach { it.leftOrNull() shouldBe AppFailure.Unauthorized }
        }

        test("[B10/AC4.3.3] Given 終了済みなのに記録が欠けている When 出力する Then 部分的な出力を返さず、失敗になる") {
            val world = World()
            val game = world.started()
            val results = (1..FINAL_WEEK).flatMap { week -> Role.entries.map { result(week, it) } }.dropLast(1)
            world.projectedFor(game, GameStatus.ENDED, results = results)

            val failure = world.export(game, game.facilitator).leftOrNull()

            (failure is AppFailure.Persistence) shouldBe true
            (failure as AppFailure.Persistence).failure.operation shouldBe "export.incomplete"
        }

        test("[B10/NF-S14] Given 終了したゲーム When 出力する Then 参加コードを含まない") {
            val world = World()
            val game = world.started()
            world.projectedFor(game, GameStatus.ENDED)

            ExportFormat.entries.forEach {
                world.export(game, game.facilitator, it).ok().body shouldNotContain game.created.joinCode
            }
        }

        test("[B10] Given 投影が無いゲーム When 出力する Then Unauthorized（存在を明かさない）") {
            val world = World()
            val game = world.started()
            world.projectedGame = null

            world.export(game, game.facilitator).leftOrNull() shouldBe AppFailure.Unauthorized
        }
    })
