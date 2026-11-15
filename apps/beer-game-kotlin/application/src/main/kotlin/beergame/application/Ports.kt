package beergame.application

import arrow.core.Either
import arrow.core.NonEmptyList
import beergame.domain.ActorRef
import beergame.domain.DomainError
import beergame.domain.DomainEvent
import beergame.domain.EventEnvelope
import beergame.domain.GameId
import beergame.domain.StreamType
import beergame.domain.StreamVersion
import beergame.domain.ValidationError
import kotlinx.coroutines.flow.Flow
import java.time.Instant
import java.util.UUID

/*
 * アプリケーション層のポート（関数の束）。型だけを持ち、実装は adapter-persistence が与える。
 * 設計の正本: docs/design/beer-game-kotlin/architecture-backend.md（AppFailure、EventStore、ProjectionLock、ChangeNotifier）。
 */

/** 1 つの DB トランザクション。中身（接続）は実装が持つ不透明な値で、アプリケーション層は触れない。 */
interface Tx

/** 例外を境界で値にしたもの。500 と相関 ID で返す。 */
data class PersistenceFailure(
    val operation: String,
    val message: String,
)

/** アプリケーション層の失敗の唯一の正本（architecture-backend.md）。 */
sealed interface AppFailure {
    /** 境界で集めた入力の誤り（ルートが execute の前に作る）。 */
    data class Invalid(
        val errors: NonEmptyList<ValidationError>,
    ) : AppFailure

    /** decide が返した業務上の失敗。 */
    data class Domain(
        val error: DomainError,
    ) : AppFailure

    /** 追記の競合。`uq_events_stream_version` の違反、40001、40P01。冪等記録の重複（再照合のための再試行）も含む。 */
    data object ConcurrencyConflict : AppFailure

    /** 競合の再試行が上限に達した、または再構築のロックの待ちが上限に達した。503 `app.retry_exhausted`。 */
    data object RetryExhausted : AppFailure

    /** 同じキーで要求の内容（本文・対象・操作者）が違う。409 `app.idempotency_key_reused`。 */
    data object IdempotencyKeyReused : AppFailure

    /** 資格が無効（失効・期限切れ・不明を区別しない）。403 `app.unauthorized`。 */
    data object Unauthorized : AppFailure

    /** 参加・復帰の失敗が上限に達した接続元（B5 Step 5）。429 `app.rate_limited`。[retryAfterSeconds] は窓が終わるまでの秒数。 */
    data class RateLimited(
        val retryAfterSeconds: Int,
    ) : AppFailure

    data class Persistence(
        val failure: PersistenceFailure,
    ) : AppFailure
}

/**
 * これから追記するイベント。ストリームの版と `schema_version` は、追記側（EventStore と EventCodec）が決める。
 * 表示名・資格の値・招待コードの値は、ここにも [payload] にも入れない（ドメインモデル D7）。
 */
data class NewEvent(
    val eventId: UUID,
    val gameId: GameId,
    val streamType: StreamType,
    val payload: DomainEvent,
    val actor: ActorRef,
    val correlationId: UUID,
    val commandId: UUID,
    val occurredAt: Instant,
)

/** 1 本のストリームの読み込み結果。[version] は最後のイベントの版（空なら 0）。 */
data class StreamRead(
    val events: List<EventEnvelope<DomainEvent>>,
    val version: StreamVersion,
)

/** 総称のメソッドを持つので、`fun interface` にはできない（設計書の記述との食い違い）。 */
interface TransactionRunner {
    /** [block] が Left を返したら ROLLBACK、Right なら COMMIT。キャンセルされても、トランザクションは必ず閉じる。 */
    suspend operator fun <A> invoke(block: suspend (Tx) -> Either<AppFailure, A>): Either<AppFailure, A>
}

/**
 * イベントストア。
 * - [append]: 期待する版（ストリームごと）から連続する版で、複数のストリームへ 1 つのトランザクションで追記する。
 *   同じ版が既にあれば `ConcurrencyConflict`。版を付けた封筒を返す（投影が使う）。
 *   `GameCreated` を含むときは、同じトランザクションで連鎖削除の根（`game_roots`）を作る。
 */
data class EventStore(
    val read: suspend (Tx, GameId, StreamType) -> Either<AppFailure, StreamRead>,
    val append: suspend (
        Tx,
        Map<StreamType, StreamVersion>,
        List<NewEvent>,
    ) -> Either<AppFailure, List<EventEnvelope<DomainEvent>>>,
    val transaction: TransactionRunner,
)

/** 追記と同じトランザクションで、投影の行を更新する（同期投影。ADR-003）。Left ならトランザクションごと取り消される。 */
fun interface ProjectionWriter {
    suspend fun write(
        tx: Tx,
        gameId: GameId,
        events: List<EventEnvelope<DomainEvent>>,
    ): Either<AppFailure, Unit>
}

/**
 * 投影の再構築との直列化（ゲーム単位）。取るだけで解放の関数は持たない（トランザクションの終了で自動的に解放される）。
 * 待ちが上限を超えたら `Left(RetryExhausted)`。
 */
data class ProjectionLock(
    val acquireShared: suspend (Tx, GameId) -> Either<AppFailure, Unit>,
    val acquireExclusive: suspend (Tx, GameId) -> Either<AppFailure, Unit>,
)

/** どのゲームの、どのストリームが、どの版まで進んだか。画面へは版だけを通知する。 */
data class VersionNotice(
    val gameId: GameId,
    val streamType: StreamType,
    val version: StreamVersion,
)

/**
 * 版の通知（SSE の元）。[publish] は追記と同じトランザクションで呼び、コミットされたときだけ配信される。
 * [isAlive] は /ready が見る（受信の接続が生きているか）。
 */
data class ChangeNotifier(
    val publish: suspend (Tx, List<VersionNotice>) -> Either<PersistenceFailure, Unit>,
    val subscribe: () -> Flow<VersionNotice>,
    val isAlive: suspend () -> Boolean,
)

/** 冪等記録の検索の鍵。`scope = "create"` のときは [gameId] を無視して `(scope, keyDigest)` で探す（ゲーム作成の重複の検出）。 */
data class IdempotencyKey(
    val gameId: GameId,
    val scope: String,
    val keyDigest: String,
) {
    val isCreate: Boolean get() = scope == CREATE_SCOPE

    companion object {
        const val CREATE_SCOPE = "create"
    }
}

/** 保存した成功の応答。[body] は呼び出し側が決めた応答のバイト列（保存時に暗号化される）。 */
data class StoredResponse(
    val gameId: GameId,
    val requestDigest: String,
    val statusCode: Int,
    val body: ByteArray,
    val expiresAt: Instant,
) {
    override fun equals(other: Any?): Boolean =
        other is StoredResponse &&
            gameId == other.gameId &&
            requestDigest == other.requestDigest &&
            statusCode == other.statusCode &&
            body.contentEquals(other.body) &&
            expiresAt == other.expiresAt

    override fun hashCode(): Int =
        listOf(gameId, requestDigest, statusCode, body.contentHashCode(), expiresAt).hashCode()
}

/**
 * 冪等記録（成功した応答だけ）。時刻は呼び出し側が渡す（`now`）。[find] は期限切れを返さない。
 * [save] は追記と同じトランザクションで呼び、同じキーの期限切れの記録は置き換える。
 * 同じキーの同時の重複は `ConcurrencyConflict` を返し、呼び出し側が再試行して記録を見つける。
 */
data class IdempotencyStore(
    val find: suspend (tx: Tx, key: IdempotencyKey, now: Instant) -> Either<AppFailure, StoredResponse?>,
    val save: suspend (tx: Tx, key: IdempotencyKey, response: StoredResponse, now: Instant) -> Either<AppFailure, Unit>,
)
