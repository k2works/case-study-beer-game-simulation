package beergame.application

import arrow.core.Either
import beergame.domain.GameId
import java.time.Duration
import java.time.Instant
import java.util.UUID

typealias Now = suspend () -> Instant

typealias NewId = suspend () -> UUID

/**
 * アプリケーション層の設定。値は外から注入する（`app` が読む）。
 * 値の根拠のうち設計書にあるのは、冪等記録の 24 時間（NF-R6）と、ブラウザセッションの 24 時間・復帰資格の 30 日
 * （NF-S4 の例）だけ。運営者との合意（R11）は未取得で、合意の前に永続環境へ出さない（B5 判断項目 2）。
 * [maxAttempts]（競合の再試行の上限）は、設計書が「実装開始時に決める」とする未決で、既定を置かない。
 */
class AppSettings(
    /** 追記の競合の再試行を含む、1 つのコマンドの試行回数の上限（1 以上。1 未満は 1 として扱う）。 */
    val maxAttempts: Int,
    val idempotencyTtl: Duration,
    /** ブラウザセッション（`browser_sessions`）の期限。 */
    val sessionTtl: Duration,
    /** 参加者の復帰資格の期限（作成・参加・復帰で新しくする）。進行役の復帰資格は、ゲームの保持期間が決める。 */
    val participantCredentialTtl: Duration,
    /** 冪等キーと要求の digest の鍵（32 バイト）。 */
    val idempotencySecret: ByteArray,
    /** 資格の digest の鍵束（版ごとの 32 バイトの鍵）。冪等記録の鍵とは別にする。 */
    val credentialKeys: CredentialKeyRing,
)

/**
 * 投影から読む（読み取り専用のトランザクションで、`projection_checkpoints` と同じ時点の行を返す）。
 * ゲームが無ければ null。開示の規則は掛けない（[Disclosure] が掛ける）。
 */
fun interface ProjectionReader {
    suspend fun read(gameId: GameId): Either<AppFailure, ProjectedGame?>
}

/** 時刻・ID・乱数。副作用なので、ポートの裏に置く（decide は時計も乱数も読まない）。 */
class Generators(
    val now: Now,
    val newId: NewId,
    val newCredential: suspend () -> String,
    val newJoinCode: suspend () -> String,
)

/** 永続化へのポート。書き込み（追記、投影、冪等記録、周辺ストア）と、読み取り（投影）。 */
class Stores(
    val events: EventStore,
    val project: ProjectionWriter,
    val idempotency: IdempotencyStore,
    val peripheral: PeripheralStore,
    val reader: ProjectionReader,
)

/**
 * 外部とのやり取りを、関数の束で表す（ガイド §7.2）。テストでは同じ型の関数に差し替える。
 * 使う側が束の入れ子を意識しないよう、各ポートは同じ名前のプロパティでも読める。
 */
class Ports(
    val generators: Generators,
    val stores: Stores,
    val lock: ProjectionLock,
    val notifier: ChangeNotifier,
    val settings: AppSettings,
) {
    val now: Now get() = generators.now
    val newId: NewId get() = generators.newId
    val newCredential: suspend () -> String get() = generators.newCredential
    val newJoinCode: suspend () -> String get() = generators.newJoinCode
    val events: EventStore get() = stores.events
    val project: ProjectionWriter get() = stores.project
    val idempotency: IdempotencyStore get() = stores.idempotency
    val peripheral: PeripheralStore get() = stores.peripheral
    val reader: ProjectionReader get() = stores.reader
}
