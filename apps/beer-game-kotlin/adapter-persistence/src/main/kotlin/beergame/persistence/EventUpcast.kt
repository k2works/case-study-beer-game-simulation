package beergame.persistence

import kotlinx.serialization.json.JsonObject

/*
 * イベントのアップキャスト（B12。data-model.md「イベントは変更しない」、operation.md「イベントスキーマの変更」）。
 * イベントの形が変わったら、`schema_version` を上げ、旧版の JSON を 1 つ新しい版の JSON へ直す純粋関数（[Upcast]）を足す。
 * 読み込みのとき、保存された版から、読める最新の版（[UpcastChain.latest]）まで順に適用して、現在の DTO で復号する。
 *
 * 2 段階のリリース（読む → 書く）: 形を変えるリリースでは、読める最新の版と [Upcast] を足す（旧版は読めるまま）。
 * 書く版（[EventCodec.CURRENT_SCHEMA_VERSION]）は上げない。全タスクが新しい読み取りになってから、次のリリースで書く版を上げる。
 * 書く版の切り替えの持ち方（環境変数か設定サービスか）は、設計で未決のため、まだ設定にしていない。
 */

/** 版 [from] の [eventType] の JSON を、版 `from + 1` の JSON へ直す純粋関数。 */
internal class Upcast(
    val eventType: String,
    val from: Int,
    val transform: (JsonObject) -> JsonObject,
)

/** 読める最新の版 [latest] までの、アップキャストの連なり。版は 1 から [latest] まで、欠けなく読める。 */
internal class UpcastChain(
    val latest: Int,
    private val upcasts: List<Upcast>,
) {
    init {
        require(latest >= 1) { "読める最新の版は 1 以上" }
        require(upcasts.all { it.from in 1 until latest }) { "アップキャストの元の版が、読める範囲に収まらない" }
        require(upcasts.groupBy { it.eventType to it.from }.values.all { it.size == 1 }) { "同じ版のアップキャストが重複している" }
    }

    fun canRead(version: Int): Boolean = version in 1..latest

    /** [payload] を版 [version] から最新の版へ直す。直す関数が無い版は、形が変わっていないので、そのまま次の版へ進む。 */
    fun toLatest(
        eventType: String,
        version: Int,
        payload: JsonObject,
    ): JsonObject =
        (version until latest).fold(payload) { current, from ->
            upcasts.firstOrNull { it.eventType == eventType && it.from == from }?.transform?.invoke(current) ?: current
        }
}

/** 本番のアップキャスト。形が変わったイベントはまだ無いので、版 1 だけで、直す関数は 0 個。 */
internal val PRODUCTION_UPCASTS = UpcastChain(latest = EventCodec.LATEST_READABLE_SCHEMA_VERSION, upcasts = emptyList())
