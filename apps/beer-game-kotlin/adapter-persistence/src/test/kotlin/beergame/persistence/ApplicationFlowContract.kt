package beergame.persistence

import arrow.core.Either
import arrow.core.raise.either
import beergame.application.AppFailure
import beergame.application.AppSettings
import beergame.application.AppTtls
import beergame.application.AttemptPolicy
import beergame.application.AttemptSource
import beergame.application.CommandOutcome
import beergame.application.CommitWeekInput
import beergame.application.CreateGameInput
import beergame.application.CredentialDigest
import beergame.application.CredentialKeyRing
import beergame.application.CredentialKind
import beergame.application.EventStore
import beergame.application.Generators
import beergame.application.JoinGameInput
import beergame.application.PeripheralWrite
import beergame.application.Ports
import beergame.application.RequestMeta
import beergame.application.RoleStatus
import beergame.application.SaveDecisionInput
import beergame.application.SecureTokens
import beergame.application.Snapshot
import beergame.application.SnapshotView
import beergame.application.Stores
import beergame.application.VerifiedCredential
import beergame.application.VerifiedRecovery
import beergame.application.assignRole
import beergame.application.commitWeek
import beergame.application.createGame
import beergame.application.joinGame
import beergame.application.recover
import beergame.application.revokeCredential
import beergame.application.saveDecision
import beergame.application.snapshot
import beergame.application.startGame
import beergame.domain.Actor
import beergame.domain.CredentialSubject
import beergame.domain.GameId
import beergame.domain.ParticipantId
import beergame.domain.Role
import beergame.domain.RoleMap
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

internal val CLOCK: Instant = Instant.parse("2026-11-14T10:00:00Z")
private val CORRELATION: UUID = UUID(9L, 9L)

private val CREDENTIAL_KEY = ByteArray(32) { (it + 7).toByte() }

/** 試験用の窓の上限と長さ（失敗 3 回まで、10 分。時計は固定なので、同じ窓に入る）。 */
internal val FLOW_ATTEMPT_POLICY: AttemptPolicy = AttemptPolicy.of(3, Duration.ofMinutes(10)).orFail()

internal fun appSettings(): AppSettings =
    AppSettings(
        maxAttempts = 5,
        ttls = AppTtls(Duration.ofHours(24), Duration.ofHours(24), Duration.ofDays(30)),
        idempotencySecret = ByteArray(32) { it.toByte() },
        credentialKeys = CredentialKeyRing.of(1, mapOf(1 to CREDENTIAL_KEY)).orFail(),
        attempts = FLOW_ATTEMPT_POLICY,
    )

/** 実物のアダプターを束ねた Ports（時計だけ固定）。[events] は、並行の試験が追記の直前に割り込むための差し替え。 */
internal fun Fixture.ports(events: EventStore = persistence.events): Ports =
    Ports(
        generators =
            Generators(
                now = { CLOCK },
                newId = { UUID.randomUUID() },
                newCredential = SecureTokens::newCredential,
                newJoinCode = SecureTokens::newJoinCode,
            ),
        stores =
            Stores(
                events = events,
                project = persistence.projections,
                idempotency = persistence.idempotency,
                peripheral = persistence.peripheral,
                attempts = persistence.attempts,
                reader = persistence.reader,
            ),
        lock = persistence.lock,
        notifier = persistence.notifier,
        settings = appSettings(),
    )

internal fun meta(
    key: String,
    credential: String? = null,
    source: AttemptSource? = null,
) = RequestMeta(key, credential, CORRELATION, source)

private data class Seat(
    val participantId: ParticipantId,
    val credential: String,
    val recovery: String,
    val name: String,
)

private data class Started(
    val gameId: GameId,
    val facilitator: String,
    val facilitatorRecovery: String,
    val joinCode: String,
    val seats: RoleMap<Seat>,
)

private val NAMES = RoleMap("工場の花子", "一次卸の次郎", "二次卸の三郎", "小売の四郎")

/**
 * 作成 → 4 人が参加 → 割り当て → 開始。需要は第 2 週が 999、第 3 週が 998（将来の需要の目印）。
 * 実 DB の待ちは IO のディスパッチャーの中にあるので、場面づくりは runBlocking で同期的に書く
 * （detekt 1.23.8 は、別のモジュールの suspend 関数の呼び出しを検出できず、suspend の修飾を冗長と誤判定するため）。
 */
private fun Fixture.start(tag: String): Started =
    runBlocking {
        val ports = ports()
        val created = ports.createGame(CreateGameInput(3, listOf(4, 999, 998), 90), meta("create-$tag")).orFail()
        val facilitator = checkNotNull(created.issued).raw
        val facilitatorRecovery = checkNotNull(created.recovery).raw
        val joinCode =
            query("SELECT join_code FROM game_join_codes WHERE game_id = ?", created.gameId.value) {
                it.getString(1)
            }.single()
        val seats =
            Role.entries.associateWith { role ->
                val outcome =
                    ports
                        .joinGame(
                            JoinGameInput(joinCode, NAMES[role]),
                            meta("join-$tag-${role.name}"),
                        ).orFail()
                val issued = checkNotNull(outcome.issued)
                val recovery = checkNotNull(outcome.recovery).raw
                Seat(ParticipantId(checkNotNull(issued.actor.id)), issued.raw, recovery, NAMES[role])
            }
        Role.entries.forEach { role ->
            ports
                .assignRole(
                    created.gameId,
                    seats.getValue(role).participantId,
                    role,
                    meta("assign-$tag-${role.name}", facilitator),
                ).orFail()
        }
        ports.startGame(created.gameId, meta("start-$tag", facilitator)).orFail()
        Started(created.gameId, facilitator, facilitatorRecovery, joinCode, RoleMap.of { seats.getValue(it) })
    }

private fun Fixture.playWeekOne(game: Started): CommandOutcome =
    runBlocking {
        val ports = ports()
        Role.entries.forEach { role ->
            ports
                .saveDecision(
                    game.gameId,
                    SaveDecisionInput(role, 1, 4, 0),
                    meta("save-${game.gameId.value}-${role.name}", game.seats[role].credential),
                ).orFail()
        }
        ports
            .commitWeek(
                game.gameId,
                CommitWeekInput(1, RoleMap.all(1L)),
                meta("commit-${game.gameId.value}", game.facilitator),
            ).orFail()
    }

private fun Snapshot.participant(): SnapshotView.Participant = view as? SnapshotView.Participant ?: error("参加者の投影ではない")

private fun Snapshot.facilitator(): SnapshotView.Facilitator = view as? SnapshotView.Facilitator ?: error("進行役の投影ではない")

/**
 * 投影が運ぶ整数の項目を、項目単位に平らにして返す。`toString()` に対する部分文字列の検索は、ランダムな UUID
 * （例: `…-998d-…`）で偶発的に一致して不安定になるため、「この値が、どの項目にも無い」は、この関数の結果で確かめる。
 */
private fun Snapshot.integerValues(): List<Int> {
    fun RoleStatus.values() = listOfNotNull(inventory, backlog, arrivals, orders, customerDemand, decision)
    val own = listOfNotNull(session?.week, session?.submittedRoleCount)
    return own +
        when (val v = view) {
            is SnapshotView.Participant -> {
                v.status?.values().orEmpty()
            }

            is SnapshotView.Facilitator -> {
                listOf(v.finalWeek) +
                    v.roles.values.flatMap { it.values() } +
                    v.results.flatMap {
                        listOf(
                            it.week,
                            it.orders,
                            it.shipped,
                            it.ordered,
                            it.endingInventory,
                            it.endingBacklog,
                        )
                    }
            }
        }
}

private fun Either<AppFailure, *>.code(): String =
    (leftOrFail() as? AppFailure.Domain)?.error?.code ?: error("業務のエラーではない: ${leftOrFail()}")

private fun Fixture.maxVersion(
    game: GameId,
    stream: String,
): Long =
    query("SELECT MAX(stream_version) FROM events WHERE game_id = ? AND stream_type = ?", game.value, stream) {
        it.getLong(1)
    }.single()

/**
 * アプリケーション層を、実物の永続化（H2 と PostgreSQL）の上で通す契約。ここが、Step 8 の「実 DB を通すもの」。
 * 手順の網羅は application の単体試験が持つので、ここでは、実 DB でだけ確かめられること
 * （資格のダイジェストの保存と認証、暗号化した応答の再送、投影の読み取りと開示、版の一致）に絞る。
 */
fun FunSpec.applicationFlowContract(fixture: () -> Fixture) {
    disclosureContract(fixture)
    peripheralContract(fixture)
    idempotencyFlowContract(fixture)
    authorizationFlowContract(fixture)
    credentialRowsContract(fixture)
    credentialRecoveryContract(fixture)
}

private fun digestOf(raw: String): String = CredentialDigest.of(CREDENTIAL_KEY, raw)

/** 失効の行の変更（イベントの追記と同じトランザクションで書く行）を、周辺ストアへ書く。 */
private fun Fixture.revoke(
    gameId: GameId,
    participantId: ParticipantId,
) = revokeSubject(gameId, CredentialSubject.Participant(participantId))

private fun Fixture.revokeSubject(
    gameId: GameId,
    subject: CredentialSubject,
) {
    val write = PeripheralWrite.RevokeSubject(gameId, subject, CLOCK)
    runBlocking { tx { tx -> persistence.peripheral.write(tx, listOf(write)) }.orFail() }
}

private fun Fixture.authenticateRecovery(
    raw: String,
    at: Instant = CLOCK,
): VerifiedRecovery? =
    runBlocking { tx { tx -> persistence.peripheral.authenticateRecovery(tx, digestOf(raw), at) }.orFail() }

private fun Fixture.authenticateSession(
    raw: String,
    at: Instant = CLOCK,
): VerifiedCredential? =
    runBlocking { tx { tx -> persistence.peripheral.authenticate(tx, digestOf(raw), at) }.orFail() }

private fun Fixture.revokedCount(gameId: GameId): Int =
    count("credentials WHERE game_id = ? AND revoked_at IS NOT NULL", gameId.value)

/**
 * 資格の行（`credentials`・`browser_sessions`）の契約（B5 Step 4）。失効は、復帰資格の失効と、同じ主体のブラウザセッションの
 * 削除を、同じトランザクションで行う（H2 案 A。スキーマ変更なし）。H2 と PostgreSQL の両方で実行する。
 */
private fun FunSpec.credentialRowsContract(fixture: () -> Fixture) {
    test("[B5/4.3] Given 参加者の資格 When 失効する Then 復帰資格の行は revoked_at が入り、ブラウザセッションの行は消え、ほかの主体の行は変わらない") {
        val fx = fixture()
        val game = fx.start("revoke-rows")
        val seat = game.seats[Role.RETAILER]

        fx.revoke(game.gameId, seat.participantId)

        fx.revokedCount(game.gameId) shouldBe 1
        fx.count(
            "credentials WHERE credential_digest = ? AND revoked_at IS NOT NULL",
            digestOf(seat.recovery),
        ) shouldBe 1
        fx.count("browser_sessions WHERE credential_digest = ?", digestOf(seat.credential)) shouldBe 0
        fx.count("browser_sessions WHERE game_id = ?", game.gameId.value) shouldBe 4
        fx.authenticateSession(seat.credential) shouldBe null
        fx.authenticateRecovery(seat.recovery) shouldBe null
        Role.entries.filter { it != Role.RETAILER }.forEach {
            checkNotNull(fx.authenticateSession(game.seats[it].credential)).gameId shouldBe game.gameId
            checkNotNull(fx.authenticateRecovery(game.seats[it].recovery)).gameId shouldBe game.gameId
        }
    }

    test("[B5/4.3] Given 進行役の主体 When 失効する Then 進行役の復帰資格とブラウザセッションだけが止まる（参加者の行は変わらない）") {
        val fx = fixture()
        val game = fx.start("revoke-facilitator")

        fx.revokeSubject(game.gameId, CredentialSubject.Facilitator(game.gameId))

        fx.revokedCount(game.gameId) shouldBe 1
        fx.authenticateSession(game.facilitator) shouldBe null
        fx.authenticateRecovery(game.facilitatorRecovery) shouldBe null
        checkNotNull(fx.authenticateSession(game.seats[Role.RETAILER].credential)).gameId shouldBe game.gameId
    }

    test("[B5/4.3] Given 失効の書き込みの後に失敗する When ROLLBACK する Then 資格の行は変わらない（追記と同じトランザクション）") {
        val fx = fixture()
        val game = fx.start("revoke-rollback")
        val seat = game.seats[Role.FACTORY]

        val failed =
            runBlocking {
                fx.tx { tx ->
                    either<AppFailure, Unit> {
                        fx.persistence.peripheral
                            .write(
                                tx,
                                listOf(
                                    PeripheralWrite.RevokeSubject(
                                        game.gameId,
                                        CredentialSubject.Participant(seat.participantId),
                                        CLOCK,
                                    ),
                                ),
                            ).bind()
                        raise(AppFailure.RetryExhausted)
                    }
                }
            }

        failed.leftOrFail() shouldBe AppFailure.RetryExhausted
        fx.revokedCount(game.gameId) shouldBe 0
        fx.count("browser_sessions WHERE game_id = ?", game.gameId.value) shouldBe 5
        checkNotNull(fx.authenticateSession(seat.credential)).gameId shouldBe game.gameId
    }
}

/** 復帰資格の認証と、復帰（期限の更新・ブラウザセッションの発行）の行の契約。 */
private fun FunSpec.credentialRecoveryContract(fixture: () -> Fixture) {
    test("[B5/4.1] Given 復帰資格 When 認証する Then 有効なら主体・ゲーム・期限が返り、不明・期限切れ・別の種類の値は null（区別しない）") {
        val fx = fixture()
        val game = fx.start("auth-recovery")
        val seat = game.seats[Role.WHOLESALER]

        val verified = checkNotNull(fx.authenticateRecovery(seat.recovery))
        val facilitator = checkNotNull(fx.authenticateRecovery(game.facilitatorRecovery))

        verified.gameId shouldBe game.gameId
        verified.actor shouldBe Actor.Participant(seat.participantId)
        verified.expiresAt shouldBe CLOCK.plus(Duration.ofDays(30))
        facilitator.actor shouldBe Actor.Facilitator(game.gameId)
        facilitator.expiresAt shouldBe CLOCK.plus(Duration.ofDays(90))
        fx.authenticateRecovery("v1.unknown") shouldBe null
        fx.authenticateRecovery(seat.credential) shouldBe null
        fx.authenticateSession(seat.recovery) shouldBe null
        fx.authenticateRecovery(seat.recovery, CLOCK.plus(Duration.ofDays(30))) shouldBe null
        fx.authenticateSession(seat.credential, CLOCK.plus(Duration.ofHours(24))) shouldBe null
        val justBeforeExpiry = CLOCK.plus(Duration.ofHours(24)).minusSeconds(1)
        checkNotNull(fx.authenticateSession(seat.credential, justBeforeExpiry)).gameId shouldBe game.gameId
    }

    test("[B5/4.3] Given 復帰 When 復帰資格の期限を新しくし、セッションを足す Then 失効した行は更新されず、有効な行だけが新しい期限になる") {
        val fx = fixture()
        val game = fx.start("extend")
        val seat = game.seats[Role.DISTRIBUTOR]
        val other = game.seats[Role.RETAILER]
        val newExpiry = CLOCK.plus(Duration.ofDays(60))
        fx.revoke(game.gameId, other.participantId)

        val writes =
            listOf(
                PeripheralWrite.ExtendRecoveryRow(digestOf(seat.recovery), newExpiry),
                PeripheralWrite.ExtendRecoveryRow(digestOf(other.recovery), newExpiry),
                PeripheralWrite.IssueSessionRow(
                    game.gameId,
                    digestOf("v1.recovered-session"),
                    CredentialKind.PARTICIPANT_RECOVERY,
                    seat.participantId.value,
                    1,
                    CLOCK.plus(Duration.ofHours(24)),
                ),
            )
        runBlocking { fx.tx { tx -> fx.persistence.peripheral.write(tx, writes) }.orFail() }

        checkNotNull(fx.authenticateRecovery(seat.recovery)).expiresAt shouldBe newExpiry
        fx.authenticateRecovery(other.recovery) shouldBe null
        fx.query("SELECT expires_at FROM credentials WHERE credential_digest = ?", digestOf(other.recovery)) {
            it.getInstant("expires_at")
        } shouldBe listOf(CLOCK.plus(Duration.ofDays(30)))
        checkNotNull(fx.authenticateSession("v1.recovered-session")).actor shouldBe
            Actor.Participant(seat.participantId)
    }
}

private fun FunSpec.disclosureContract(fixture: () -> Fixture) {
    test("[B1/Step8] Given 実 DB When 作成から確定までを通す Then 役割ごとの投影が開示の規則どおりに返り、版は DB の最大の版と一致する") {
        val fx = fixture()
        val game = fx.start("flow")
        fx.playWeekOne(game)
        val ports = fx.ports()

        val wholesaler = ports.snapshot(game.gameId, game.seats[Role.WHOLESALER].credential).orFail()
        val retailer = ports.snapshot(game.gameId, game.seats[Role.RETAILER].credential).orFail()
        val facilitator = ports.snapshot(game.gameId, game.facilitator).orFail()

        // AC2.3.1: 確定後は第 2 週の状況
        wholesaler.session?.week shouldBe 2
        checkNotNull(wholesaler.participant().status).customerDemand shouldBe null
        // AC2.1.3: 小売店だけが当週（第 2 週）の顧客需要 999 を読む。将来（第 3 週）の 998 は、どの投影にも無い
        checkNotNull(retailer.participant().status).customerDemand shouldBe 999
        listOf(wholesaler, retailer, facilitator).forEach { it.integerValues() shouldNotContain 998 }
        retailer.integerValues() shouldContain 999
        // AC2.1.1: 自分の役割の値だけ。他の参加者の表示名・参加コードは返らない
        listOf(
            Role.FACTORY,
            Role.DISTRIBUTOR,
            Role.RETAILER,
        ).forEach { wholesaler.toString() shouldNotContain NAMES[it] }
        wholesaler.toString() shouldNotContain game.joinCode
        // 進行役: 全体
        val view = facilitator.facilitator()
        view.joinCode shouldBe game.joinCode
        view.roles.keys shouldBe Role.entries.toSet()
        view.results.size shouldBe 4
        // ロビーの並びは、参加の時刻（この試験では固定の時計で同じ）→ 参加者 ID の順なので、集合で比べる
        view.lobby.map { it.displayName }.toSet() shouldBe Role.entries.map { NAMES[it] }.toSet()
        view.lobby.associate { it.displayName to it.role } shouldBe Role.entries.associate { NAMES[it] to it }
        // 版: 投影が反映した版は、DB の最大の版（GAME: 作成 1 + 参加 4 + 割り当て 4 + 開始 1、SESSION: 開始 1 + 保存 4 + 確定 1）
        facilitator.versions.game?.value shouldBe fx.maxVersion(game.gameId, "GAME")
        facilitator.versions.session?.value shouldBe fx.maxVersion(game.gameId, "SESSION")
        facilitator.versions.game?.value shouldBe 10
        facilitator.versions.session?.value shouldBe 6
    }
}

private fun FunSpec.peripheralContract(fixture: () -> Fixture) {
    test("[#14/NF-S14] Given 実 DB で参加した 4 人 When テーブルを見る Then 資格はダイジェストだけ・ブラウザセッションは同じダイジェスト・表示名はイベントに無い") {
        val fx = fixture()
        val game = fx.start("peripheral")
        val raws =
            listOf(game.facilitator, game.facilitatorRecovery) +
                Role.entries.flatMap { listOf(game.seats[it].credential, game.seats[it].recovery) }

        fx.count("credentials WHERE game_id = ?", game.gameId.value) shouldBe 5
        fx.count("browser_sessions WHERE game_id = ?", game.gameId.value) shouldBe 5
        fx.count("display_profiles WHERE game_id = ?", game.gameId.value) shouldBe 4
        raws.forEach { raw ->
            fx.count("credentials WHERE credential_digest = ?", raw) shouldBe 0
            fx.count("browser_sessions WHERE credential_digest = ?", raw) shouldBe 0
        }
        // B5 Step 4: ブラウザセッションと復帰資格は、別の値・別のダイジェスト（B1 は 1 つの値で兼ねた）
        fx.count(
            "credentials c JOIN browser_sessions s ON s.credential_digest = c.credential_digest WHERE c.game_id = ?",
            game.gameId.value,
        ) shouldBe 0
        fx.query("SELECT DISTINCT key_version FROM credentials WHERE game_id = ?", game.gameId.value) {
            it.getInt(1)
        } shouldBe listOf(1)
        fx.query("SELECT DISTINCT key_version FROM browser_sessions WHERE game_id = ?", game.gameId.value) {
            it.getInt(1)
        } shouldBe listOf(1)
        NAMES.values.forEach { name ->
            fx.count(
                "events WHERE game_id = ? AND CAST(payload AS VARCHAR) LIKE ?",
                game.gameId.value,
                "%$name%",
            ) shouldBe
                0
        }
    }
}

private fun FunSpec.idempotencyFlowContract(fixture: () -> Fixture) {
    test("[ADR-004] Given 実 DB で作成した進行役 When 同じキーで作成を再送する Then 暗号化して保存した応答から、同じゲームと同じ資格を返し、ゲームは 1 つのまま") {
        val fx = fixture()
        val ports = fx.ports()
        val request = CreateGameInput(3, listOf(4, 4, 4), 90)

        val first = ports.createGame(request, meta("create-replay")).orFail()
        val second = ports.createGame(request, meta("create-replay")).orFail()

        second shouldBe first
        fx.count("game_roots WHERE game_id = ?", first.gameId.value) shouldBe 1
        fx.count("events WHERE game_id = ?", first.gameId.value) shouldBe 1
    }

    test("[AC2.3.2/AC2.3.5] Given 実 DB で確定した第 1 週 When 新しいキーで再び確定する Then session.week_advanced で、週の結果は 4 役割分だけ") {
        val fx = fixture()
        val game = fx.start("commit-twice")
        fx.playWeekOne(game)
        val ports = fx.ports()

        val again =
            ports.commitWeek(
                game.gameId,
                CommitWeekInput(1, RoleMap.all(1L)),
                meta("commit-again", game.facilitator),
            )

        again.code() shouldBe "session.week_advanced"
        fx.count("week_role_results WHERE game_id = ?", game.gameId.value) shouldBe 4
        fx.count("week_commits WHERE game_id = ?", game.gameId.value) shouldBe 1
    }
}

private fun FunSpec.authorizationFlowContract(fixture: () -> Fixture) {
    test("[ADR-004][H4] Given 実 DB で成功した操作 When 資格が失効した後に同じキーを再送する Then app.unauthorized で、スナップショットも取れない") {
        val fx = fixture()
        val game = fx.start("revoked")
        val ports = fx.ports()
        val seat = game.seats[Role.RETAILER]
        val request = SaveDecisionInput(Role.RETAILER, 1, 4, 0)
        ports.saveDecision(game.gameId, request, meta("save-old-key", seat.credential)).orFail()
        fx.revoke(game.gameId, seat.participantId)

        val replay = ports.saveDecision(game.gameId, request, meta("save-old-key", seat.credential))
        val snapshot = ports.snapshot(game.gameId, seat.credential)

        replay.leftOrFail() shouldBe AppFailure.Unauthorized
        snapshot.leftOrFail() shouldBe AppFailure.Unauthorized
    }

    test("[AC1.2.2] Given 実 DB When 存在しない参加コードで参加する Then game.invitation_invalid") {
        val fx = fixture()

        fx.ports().joinGame(JoinGameInput("NO-SUCH-CODE-X", "田中"), meta("join-bad")).code() shouldBe
            "game.invitation_invalid"
    }

    test("[AC2.2.2/US2.1] Given 実 DB で開始した 4 人 When 工場の参加者が小売店の入力を保存し、二次卸が小売店を取得する Then どちらも拒否し、値は保存も返却もされない") {
        val fx = fixture()
        val game = fx.start("forbidden")
        val ports = fx.ports()

        val save =
            ports.saveDecision(
                game.gameId,
                SaveDecisionInput(Role.RETAILER, 1, 4, 0),
                meta("cross", game.seats[Role.FACTORY].credential),
            )
        val read = ports.snapshot(game.gameId, game.seats[Role.WHOLESALER].credential, requestedRole = Role.RETAILER)

        save.code() shouldBe "session.forbidden"
        read.code() shouldBe "game.forbidden"
        fx.count("current_decisions WHERE game_id = ?", game.gameId.value) shouldBe 0
    }
}

private const val RACE_ROUNDS = 8

/** 2 つの要求が、追記の直前にそろうまで待つための合流点（両方が同じ版を読んでから追記を試みる状況を、確実に作る）。 */
private class Barrier(
    private val parties: Int,
) {
    private val arrived = AtomicInteger()
    private val gate = CompletableDeferred<Unit>()

    // suspend の関数型の値にしてある（detekt 1.23.8 が、Kotlin 2.4 でビルドされたライブラリの suspend 呼び出しを検出できず、
    // `suspend` の修飾を冗長と誤判定するため。`@Suppress` も設定の緩和も使わない。AppTestKit の `sendRequest` と同じ理由）
    val await: suspend () -> Unit = {
        if (arrived.incrementAndGet() == parties) gate.complete(Unit)
        gate.await()
    }
}

/**
 * 最初の追記の直前に [barrier] で待ち合わせ、追記の競合（ConcurrencyConflict）の回数を [conflicts] に数える。
 * 再試行の追記は待たない（敗者は、勝者のコミットの後に、最初から評価し直す）。
 */
private fun EventStore.racing(
    barrier: Barrier,
    conflicts: AtomicInteger,
): EventStore {
    val first = AtomicBoolean(true)
    return copy(
        append = { tx, expected, events ->
            if (first.compareAndSet(true, false)) barrier.await()
            append(tx, expected, events).onLeft {
                if (it ==
                    AppFailure.ConcurrencyConflict
                ) {
                    conflicts.incrementAndGet()
                }
            }
        },
    )
}

private data class Raced(
    val conflicts: Int,
    val recoverWon: Boolean,
)

/**
 * 進行役の失効と、参加者の復帰を、同じ版のゲームのストリームから同時に追記させ、競合の後の結果を検査する。
 * 勝つ側は実行ごとに決まらないので、どちらの順でも成り立つ不変条件を確かめる。
 */
private fun Fixture.raceRevokeAndRecover(tag: String): Raced {
    val game = start(tag)
    val seat = game.seats[Role.RETAILER]
    val before = maxVersion(game.gameId, "GAME")
    val barrier = Barrier(2)
    val conflicts = AtomicInteger()
    val (revoked, recovered) =
        runBlocking {
            val go = CompletableDeferred<Unit>()
            val revoke =
                async {
                    go.await()
                    ports(persistence.events.racing(barrier, conflicts))
                        .revokeCredential(
                            game.gameId,
                            CredentialSubject.Participant(seat.participantId),
                            meta("revoke-$tag", game.facilitator),
                        )
                }
            val recover =
                async {
                    go.await()
                    ports(
                        persistence.events.racing(barrier, conflicts),
                    ).recover(game.gameId, meta("recover-$tag", seat.recovery))
                }
            go.complete(Unit)
            revoke.await() to recover.await()
        }

    revoked.orFail()
    // 復帰が負けた場合は、失効の後に評価し直されて、無効な資格として拒否される（再試行の上限や競合は漏れない）
    recovered.onLeft { it shouldBe AppFailure.Unauthorized }
    val events =
        query(
            "SELECT stream_version, event_type FROM events " +
                "WHERE game_id = ? AND stream_type = 'GAME' AND stream_version > ? ORDER BY stream_version",
            game.gameId.value,
            before,
        ) { it.getLong(1) to it.getString(2) }
    events.map { it.first } shouldBe (1..events.size).map { before + it }
    events.map { it.second } shouldBe
        if (recovered.isRight()) listOf("ParticipationRecovered", "CredentialRevoked") else listOf("CredentialRevoked")
    // どちらの順でも、失効は効いている。復帰で得た新しいセッションも、失効で止まる
    recovered.onRight { authenticateSession(checkNotNull(it.outcome.issued).raw) shouldBe null }
    authenticateSession(seat.credential) shouldBe null
    authenticateRecovery(seat.recovery) shouldBe null
    count("browser_sessions WHERE game_id = ? AND actor_id = ?", game.gameId.value, seat.participantId.value) shouldBe 0
    revokedCount(game.gameId) shouldBe 1
    return Raced(conflicts.get(), recovered.isRight())
}

/**
 * 実 DB（PostgreSQL）の並行の契約（B5 Step 8.4b）。資格の失効と復帰が同時に実行されても、ゲームのストリームの版の競合で
 * 直列化され、失効した後に復帰で得たセッションが生き残らないことを確かめる。H2 では実行しない（実際の並行は PostgreSQL が正）。
 */
fun FunSpec.credentialConcurrencyContract(fixture: () -> Fixture) {
    test(
        "[B5/8.4b] Given 実 DB When 失効と復帰を同じ版から同時に追記する Then 競合で直列化され、版は欠けず、どちらの順でも復帰のセッションは失効で止まる",
    ) {
        val fx = fixture()

        val rounds = (1..RACE_ROUNDS).map { fx.raceRevokeAndRecover("race-$it") }

        // 追記の直前に待ち合わせるので、毎回、ちょうど 1 回の競合が起きる（敗者の再試行は競合しない）
        rounds.map { it.conflicts } shouldBe List(RACE_ROUNDS) { 1 }
    }
}
