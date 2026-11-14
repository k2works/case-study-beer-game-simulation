package beergame.http

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.slf4j.LoggerFactory

/**
 * 構造化ログの 1 件。**項目として、資格・表示名・参加コード・冪等キー・非公開の値を持たない**（型で除外する。
 * 秘匿の設定に頼らない。NF-O1、NF-S14）。項目を足すときは、`LogRecordSpec` の許可リストを人が確かめて直す。
 *
 * [gameId] は不透明な UUID（参加コードではない）。[message] は、コードに書いた固定の文だけを入れる
 * （例外のメッセージや入力の値は入れない）。[errorType] と [stack] は、予期しない例外のクラス名とスタックの各行。
 */
@Serializable
data class LogRecord(
    val timestamp: String,
    val level: String,
    val correlationId: String,
    val operation: String,
    val result: String,
    val status: Int,
    val durationMillis: Long,
    val gameId: String? = null,
    val gameVersion: Long? = null,
    val sessionVersion: Long? = null,
    val message: String? = null,
    val errorType: String? = null,
    val stack: List<String>? = null,
) {
    fun toJsonLine(): String = LOG_JSON.encodeToString(serializer(), this)

    companion object {
        private val LOG_JSON = Json { explicitNulls = false }
    }
}

/** ログの出力先。試験では集めて確かめる。 */
fun interface LogSink {
    fun emit(record: LogRecord)
}

/**
 * SLF4J（実装は Logback）へ、1 件を 1 行の JSON として出す。標準出力へ出す設定は `app` の `logback.xml`。
 * アプリのログはこの JSON、Logback 自体は枠組みのログ用。
 */
class Slf4jLogSink : LogSink {
    private val logger = LoggerFactory.getLogger("beergame.log")

    override fun emit(record: LogRecord) {
        val line = record.toJsonLine()
        when (record.level) {
            LEVEL_ERROR -> logger.error(line)
            LEVEL_WARN -> logger.warn(line)
            else -> logger.info(line)
        }
    }
}

const val LEVEL_INFO = "INFO"
const val LEVEL_WARN = "WARN"
const val LEVEL_ERROR = "ERROR"
