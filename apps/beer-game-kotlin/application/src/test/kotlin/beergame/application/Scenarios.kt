package beergame.application

import beergame.domain.GameId
import beergame.domain.ParticipantId
import beergame.domain.Role
import beergame.domain.RoleMap
import kotlinx.coroutines.runBlocking

/*
 * 試験の場面づくり。世界（World）はメモリ上で、実際の待ちが無いので、場面づくりは runBlocking で同期的に書く
 * （detekt 1.23.8 は、別のモジュールの suspend 関数の呼び出しを検出できず、suspend の修飾を冗長と誤判定するため）。
 */

/** 1 人の参加者。生の資格は、応答だけが運んだ値（世界には、そのダイジェストだけがある）。 */
data class Seat(
    val participantId: ParticipantId,
    val credential: String,
)

data class Created(
    val gameId: GameId,
    val facilitator: String,
    val joinCode: String,
)

data class Prepared(
    val created: Created,
    val seats: RoleMap<Seat>,
) {
    val gameId: GameId get() = created.gameId
    val facilitator: String get() = created.facilitator
}

/** 需要 4、4、4 の 3 週のゲームを作る。 */
fun World.createGame(
    tag: String = "",
    demand: List<Int> = listOf(4, 4, 4),
): Created =
    runBlocking {
        val outcome = ports.createGame(CreateGameInput(demand.size, demand, 90), meta("create-$tag")).ok()
        val code =
            store.joinCodes.entries
                .first { it.value == outcome.gameId }
                .key
        Created(outcome.gameId, checkNotNull(outcome.issued).raw, code)
    }

fun World.join(
    created: Created,
    name: String,
    key: String,
): Seat =
    runBlocking {
        val outcome = ports.joinGame(JoinGameInput(created.joinCode, name), meta(key)).ok()
        val issued = checkNotNull(outcome.issued)
        Seat(ParticipantId(checkNotNull(issued.actor.id)), issued.raw)
    }

/** 4 人が参加し、役割（工場、一次卸、二次卸、小売店）に 1 人ずつ割り当て済み。開始前。 */
fun World.prepared(
    demand: List<Int> = listOf(4, 4, 4),
    tag: String = "",
): Prepared =
    runBlocking {
        val created = createGame(tag, demand)
        val joined =
            Role.entries.associateWith { role ->
                join(created, "参加者${role.ordinal + 1}", "join-$tag-${role.name}")
            }
        val seats = RoleMap.of { role -> joined.getValue(role) }
        Role.entries.forEach { role ->
            ports
                .assignRole(
                    created.gameId,
                    seats[role].participantId,
                    role,
                    meta("assign-$tag-${role.name}", created.facilitator),
                ).ok()
        }
        Prepared(created, seats)
    }

fun World.started(
    demand: List<Int> = listOf(4, 4, 4),
    tag: String = "",
): Prepared =
    prepared(demand, tag).also {
        runBlocking { ports.startGame(it.gameId, meta("start-$tag", it.facilitator)).ok() }
    }

/** 4 役割が、それぞれ [quantity] を保存する。 */
fun World.saveAll(
    game: Prepared,
    quantity: Int = 4,
    week: Int = 1,
) {
    runBlocking {
        Role.entries.forEach { role ->
            ports
                .saveDecision(
                    game.gameId,
                    SaveDecisionInput(role, week, quantity, 0),
                    meta("save-w$week-${role.name}", game.seats[role].credential),
                ).ok()
        }
    }
}
