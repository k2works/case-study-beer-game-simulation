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
    val ttls: AppTtls,
    /** 冪等キーと要求の digest の鍵（32 バイト）。 */
    val idempotencySecret: ByteArray,
    /** 資格の digest の鍵束（版ごとの 32 バイトの鍵）。冪等記録の鍵とは別にする。 */
    val credentialKeys: CredentialKeyRing,
    /** 参加・復帰の窓（失敗の上限と長さ。B5 Step 5）。 */
    val attempts: AttemptPolicy,
) {
    val idempotencyTtl: Duration get() = ttls.idempotency
    val sessionTtl: Duration get() = ttls.session
    val participantCredentialTtl: Duration get() = ttls.participantCredential
    val observerInvitationTtl: Duration get() = ttls.observerInvitation
}

/**
 * 期限の束。[session] はブラウザセッション（`browser_sessions`）、[participantCredential] は参加者の復帰資格
 * （作成・参加・復帰で新しくする。進行役の復帰資格は、ゲームの保持期間が決める）。
 */
class AppTtls(
    val idempotency: Duration,
    val session: Duration,
    val participantCredential: Duration,
    /** 観察用の招待の有効期間（B9。設計の未決の仮置き。既定は 7 日）。 */
    val observerInvitation: Duration = Duration.ofDays(OBSERVER_INVITATION_DAYS),
) {
    private companion object {
        const val OBSERVER_INVITATION_DAYS = 7L
    }
}

/**
 * 投影から読む（読み取り専用のトランザクションで、`projection_checkpoints` と同じ時点の行を返す）。
 * ゲームが無ければ null。開示の規則は掛けない（[Disclosure] が掛ける）。
 */
fun interface ProjectionReader {
    suspend fun read(gameId: GameId): Either<AppFailure, ProjectedGame?>
}

/**
 * 観察者の読み取り（B9）。**観察者が読める 3 表（`game_overview`・`session_overview`・`week_team_totals`）だけ**を読む。
 * 参加コード・役割別の表・設定には到達しない（BR-17。DB のロールでも `beergame_observer` の SELECT はこの 3 表だけ）。
 * ゲームが無ければ null。開示の規則は掛けない（[Disclosure.forObservation] が掛ける）。
 */
fun interface ObservationReader {
    suspend fun read(gameId: GameId): Either<AppFailure, ProjectedObservation?>
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
    val attempts: AttemptStore,
    val reader: ProjectionReader,
    /** 観察者用の読み取り。無ければ（null）、[reader] から導く（観察者のロール・接続プールを分けない構成）。 */
    val observation: ObservationReader? = null,
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
    val attempts: AttemptStore get() = stores.attempts
    val reader: ProjectionReader get() = stores.reader

    /** 観察者用の読み取り。専用のポートが無い構成は、主の読み取りから、観察者が読める項目だけを取り出す。 */
    val observation: ObservationReader
        get() =
            stores.observation ?: ObservationReader { id -> reader.read(id).map { game -> game?.toObservation() } }
}
