package beergame.application

import arrow.core.Either
import arrow.core.raise.either
import arrow.core.raise.ensure
import arrow.core.raise.ensureNotNull
import beergame.domain.ActorKind
import beergame.domain.ActorRef
import beergame.domain.GameId
import beergame.domain.StreamVersion
import java.nio.charset.StandardCharsets
import java.util.UUID

/** 追記したストリームごとの、追記後の版。追記しなかったストリームは null。 */
data class Versions(
    val game: StreamVersion?,
    val session: StreamVersion?,
)

/**
 * コマンドの成功の応答。画面の表示に使う内容は持たない（ストリームごとの版だけ。H8）。
 * [issued] は、資格を発行した操作（作成、参加）の応答だけが持ち、生の値を運ぶ。冪等記録は、これを暗号化して保存する。
 * [gameId] は、作成の再送が同じゲームを返すために要る。
 */
data class CommandOutcome(
    val gameId: GameId,
    val versions: Versions,
    val issued: IssuedCredential? = null,
)

/**
 * [CommandOutcome] の、冪等記録に保存する本文（暗号化は永続化の層が行う）。
 * 行ごとの `名前=値` の素朴な形式で、外部の直列化の道具に依存しない。復元の失敗は例外でなく値で返す。
 */
object OutcomeCodec {
    private const val HEADER = "v1"
    private const val NONE = "-"

    fun encode(outcome: CommandOutcome): ByteArray {
        val issued =
            outcome.issued?.let {
                listOf(it.raw, it.kind.name, it.actor.kind.name, it.actor.id?.toString() ?: NONE).joinToString("|")
            }
        return listOf(
            HEADER,
            "gameId=${outcome.gameId.value}",
            "game=${outcome.versions.game?.value ?: NONE}",
            "session=${outcome.versions.session?.value ?: NONE}",
            "credential=${issued ?: NONE}",
        ).joinToString("\n").toByteArray(StandardCharsets.UTF_8)
    }

    fun decode(bytes: ByteArray): Either<AppFailure, CommandOutcome> =
        either {
            val lines = String(bytes, StandardCharsets.UTF_8).split('\n')
            ensure(lines.firstOrNull() == HEADER) { broken("形式の版が違う") }
            val fields =
                lines.drop(1).filter { it.contains('=') }.associate {
                    it.substringBefore('=') to
                        it.substringAfter('=')
                }
            val gameId = ensureNotNull(fields["gameId"]?.let(::uuidOrNull)) { broken("gameId が不正") }
            val game = ensureNotNull(version(fields["game"])) { broken("game の版が不正") }
            val session = ensureNotNull(version(fields["session"])) { broken("session の版が不正") }
            val issued = ensureNotNull(issued(fields["credential"])) { broken("資格が不正") }
            CommandOutcome(GameId(gameId), Versions(game.value, session.value), issued.value)
        }

    private fun broken(reason: String): AppFailure =
        AppFailure.Persistence(PersistenceFailure("idempotency.decode", "保存済みの応答を復元できない: $reason"))

    private fun uuidOrNull(text: String): UUID? = Either.catch { UUID.fromString(text) }.getOrNull()

    /** 値が無い（`-`）は Some(null)、不正は null。 */
    private fun version(text: String?): Box<StreamVersion>? =
        when {
            text == null -> null
            text == NONE -> Box(null)
            else -> text.toLongOrNull()?.let { StreamVersion.of(it).getOrNull() }?.let { Box(it) }
        }

    private fun issued(text: String?): Box<IssuedCredential>? =
        when {
            text == null -> null
            text == NONE -> Box(null)
            else -> parseIssued(text.split('|'))?.let { Box(it) }
        }

    private fun parseIssued(parts: List<String>): IssuedCredential? {
        val fields = parts.takeIf { it.size == ISSUED_PARTS } ?: return null
        val (raw, kindName, actorKindName) = fields
        val actorIdText = fields.last()
        val kind = CredentialKind.entries.firstOrNull { it.name == kindName }
        val actorKind = ActorKind.entries.firstOrNull { it.name == actorKindName }
        val actorId = if (actorIdText == NONE) Box(null) else uuidOrNull(actorIdText)?.let { Box(it) }
        return if (kind == null || actorKind == null || actorId == null) {
            null
        } else {
            IssuedCredential(raw, kind, ActorRef(actorKind, actorId.value))
        }
    }

    private const val ISSUED_PARTS = 4

    /** 「値が無い」と「不正」を区別するための入れ物。 */
    private class Box<out A : Any>(
        val value: A?,
    )
}
