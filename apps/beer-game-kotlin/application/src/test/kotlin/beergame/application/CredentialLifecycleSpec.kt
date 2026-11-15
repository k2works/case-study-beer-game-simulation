package beergame.application

import arrow.core.Either
import beergame.domain.CredentialSubject
import beergame.domain.GameEvent
import beergame.domain.GameId
import beergame.domain.Role
import beergame.domain.StreamType
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldStartWith
import kotlinx.coroutines.runBlocking
import java.time.Duration

/*
 * 資格の失効・再発行・復帰と、認可 → 冪等記録の照合の順序（B5 Step 4。R5・高リスク。否定テストを先に書いた）。
 * 資格に関わる行の変更（`credentials`・`browser_sessions`）は、対応するイベントなしに起きないことと、
 * 失効した資格が、以前に成功したキーを再送しても 403 になる（保存済みの応答を返さない。ADR-004）ことを守る。
 * 応答（HTTP）への配線は Step 6。ここは、application の内側（internal の操作）を、実際のコマンド経由で動かす。
 */

private fun Prepared.subject(role: Role) = CredentialSubject.Participant(seats[role].participantId)

private fun World.revoke(
    game: Prepared,
    role: Role,
    key: String = "revoke-${role.name}",
): Either<AppFailure, CommandOutcome> =
    runBlocking { ports.revokeCredential(game.gameId, game.subject(role), meta(key, game.facilitator)) }

private fun World.reissue(
    game: Prepared,
    role: Role,
    key: String = "reissue-${role.name}",
): Either<AppFailure, CommandOutcome> =
    runBlocking { ports.reissueCredential(game.gameId, game.subject(role), meta(key, game.facilitator)) }

private fun World.recover(
    gameId: GameId,
    recovery: String?,
    key: String,
): Either<AppFailure, CommandOutcome> = runBlocking { ports.recoverParticipation(gameId, meta(key, recovery)) }

/** 復帰して、新しいブラウザセッションの値（発行した資格）を得る。 */
private fun World.recoveredSession(
    gameId: GameId,
    recovery: String,
    key: String,
): IssuedCredential = checkNotNull(recover(gameId, recovery, key).ok().issued)

private fun World.rotateKeys(
    current: Int,
    vararg keys: Pair<Int, ByteArray>,
) {
    settings = testSettings(credentialKeys = keyRing(current, *keys))
}

private fun World.save(
    game: Prepared,
    role: Role,
    credential: String,
    key: String,
): Either<AppFailure, CommandOutcome> =
    runBlocking { ports.saveDecision(game.gameId, SaveDecisionInput(role, 1, 4, 0), meta(key, credential)) }

private fun World.attempts(call: String): Int = calls.count { it == call }

private fun World.gameEvents(gameId: GameId) = store.events(gameId, StreamType.GAME)

class CredentialLifecycleSpec :
    FunSpec({
        context("[ADR-004][B5] 失効した資格の再送は 403（以前に成功したキーでも、保存済みの応答を返さない）") {
            test("Given 成功した保存 When 進行役が失効させた後に同じキーを再送する Then app.unauthorized で、冪等記録を検索せず、読み込みも追記もしない") {
                val world = World()
                val game = world.started()
                val seat = game.seats[Role.RETAILER]
                world.save(game, Role.RETAILER, seat.credential, "save-old-key").ok()
                world.revoke(game, Role.RETAILER).ok()
                world.clearCalls()

                val replay = world.save(game, Role.RETAILER, seat.credential, "save-old-key")

                replay.err() shouldBe AppFailure.Unauthorized
                world.calls shouldNotContain "idempotency.find"
                world.calls shouldNotContain "events.read"
                world.calls shouldNotContain "events.append"
                world.calls shouldContain "authenticate"
            }

            test("Given 失効した参加者 When 状況を取得する Then app.unauthorized。ほかの参加者のブラウザセッションは有効のまま") {
                val world = World()
                val game = world.started()
                world.revoke(game, Role.RETAILER).ok()

                world.ports.snapshot(game.gameId, game.seats[Role.RETAILER].credential).err() shouldBe
                    AppFailure.Unauthorized
                world.save(game, Role.FACTORY, game.seats[Role.FACTORY].credential, "factory-save").ok()
            }

            test("Given 失効した後に再発行した When 失効前のブラウザセッションで操作する Then 復活せず app.unauthorized（古いセッションが蘇らない）") {
                val world = World()
                val game = world.started()
                val seat = game.seats[Role.RETAILER]
                world.revoke(game, Role.RETAILER).ok()

                world.reissue(game, Role.RETAILER).ok()

                world.save(game, Role.RETAILER, seat.credential, "after-reissue").err() shouldBe AppFailure.Unauthorized
                world.ports.snapshot(game.gameId, seat.credential).err() shouldBe AppFailure.Unauthorized
            }

            test("Given 参加者の入力 When 進行役の資格でない者が失効させようとする Then game.forbidden で、行は何も変わらない") {
                val world = World()
                val game = world.started()
                val before = world.store.credentials to world.store.browserSessions

                val byParticipant =
                    runBlocking {
                        world.ports.revokeCredential(
                            game.gameId,
                            game.subject(Role.FACTORY),
                            meta("forbidden", game.seats[Role.RETAILER].credential),
                        )
                    }

                byParticipant.domainCode() shouldBe "game.forbidden"
                (world.store.credentials to world.store.browserSessions) shouldBe before
            }
        }

        context("[ADR-004][B5/a2] 復帰（RecoverParticipation）は、提示した復帰資格の有効性が認可。冪等記録の照合より前に検証する") {
            test("Given 有効な復帰資格 When 復帰する Then 新しいブラウザセッションの値が返り、それで操作できる") {
                val world = World()
                val game = world.started()
                val seat = game.seats[Role.RETAILER]

                val outcome = world.recover(game.gameId, seat.recovery, "recover-1").ok()
                val session = checkNotNull(outcome.issued)

                (session.raw == seat.credential) shouldBe false
                session.raw shouldStartWith "v1."
                session.actor.id shouldBe seat.participantId.value
                world.save(game, Role.RETAILER, session.raw, "save-after-recover").ok()
            }

            test("Given 成功した復帰 When 同じキーと同じ復帰資格で再送する Then 保存した応答（同じセッション）を返し、追記しない") {
                val world = World()
                val game = world.started()
                val seat = game.seats[Role.RETAILER]
                val first = world.recover(game.gameId, seat.recovery, "recover-same").ok()
                val eventsBefore = world.gameEvents(game.gameId).size
                world.clearCalls()

                val second = world.recover(game.gameId, seat.recovery, "recover-same").ok()

                second shouldBe first
                world.gameEvents(game.gameId).size shouldBe eventsBefore
                world.calls shouldContain "idempotency.find"
                world.calls shouldNotContain "events.append"
            }

            test("Given 成功した復帰 When 復帰資格が失効した後に同じキーで再送する Then app.unauthorized で、保存した新しいセッションを返さない") {
                val world = World()
                val game = world.started()
                val seat = game.seats[Role.RETAILER]
                world.recover(game.gameId, seat.recovery, "recover-old").ok()
                world.revoke(game, Role.RETAILER).ok()
                world.clearCalls()

                val replay = world.recover(game.gameId, seat.recovery, "recover-old")

                replay.err() shouldBe AppFailure.Unauthorized
                world.calls shouldNotContain "idempotency.find"
                world.calls shouldContain "authenticateRecovery"
                world.calls shouldNotContain "events.append"
            }

            test("Given 同じキーで成功した復帰 When 別の復帰資格（別の主体）で同じキーを送る Then 内容が違う要求として app.idempotency_key_reused") {
                val world = World()
                val game = world.started()
                world.recover(game.gameId, game.seats[Role.RETAILER].recovery, "shared-key").ok()

                val other = world.recover(game.gameId, game.seats[Role.FACTORY].recovery, "shared-key")

                other.err() shouldBe AppFailure.IdempotencyKeyReused
            }

            test("Given 進行役の復帰資格 When 復帰する Then 進行役のブラウザセッションが返り、復帰資格の期限は延ばさない（保持期間のまま）") {
                val world = World()
                val created = world.createGame()
                world.clock = T0.plusSeconds(3_600)

                val outcome = world.recover(created.gameId, created.facilitatorRecovery, "recover-facilitator").ok()
                val session = checkNotNull(outcome.issued)

                session.kind shouldBe CredentialKind.FACILITATOR
                session.actor.id shouldBe created.gameId.value
                world.store.credentials.values
                    .single()
                    .expiresAt shouldBe T0.plus(Duration.ofDays(90))
            }
        }

        context("[B5/b] 期限") {
            test("Given ブラウザセッションの期限（24 時間）を過ぎた When 操作する Then app.unauthorized。復帰資格（30 日）は有効で、復帰すると操作できる") {
                val world = World()
                val game = world.started()
                val seat = game.seats[Role.RETAILER]
                world.clock = T0.plus(Duration.ofHours(24)).plusSeconds(1)

                world.save(game, Role.RETAILER, seat.credential, "expired-session").err() shouldBe
                    AppFailure.Unauthorized
                val recovered = world.recoveredSession(game.gameId, seat.recovery, "recover-after-expiry")
                world.save(game, Role.RETAILER, recovered.raw, "save-recovered").ok()
            }

            test("Given 復帰資格の期限（30 日）を過ぎた When 復帰する Then app.unauthorized") {
                val world = World()
                val game = world.started()
                world.clock = T0.plus(Duration.ofDays(30)).plusSeconds(1)

                world.recover(game.gameId, game.seats[Role.RETAILER].recovery, "expired-recovery").err() shouldBe
                    AppFailure.Unauthorized
            }

            test("Given 復帰した When 復帰資格の期限を見る Then 復帰した時刻から新しい 30 日になり、ブラウザセッションの期限は 24 時間") {
                val world = World()
                val game = world.started()
                val seat = game.seats[Role.RETAILER]
                world.clock = T0.plus(Duration.ofDays(10))

                val session = checkNotNull(world.recover(game.gameId, seat.recovery, "recover-extend").ok().issued)

                world.store.credentials.values
                    .filter { it.subjectId == seat.participantId.value }
                    .single()
                    .expiresAt shouldBe T0.plus(Duration.ofDays(40))
                world.store.browserSessions.values
                    .filter { it.subjectId == seat.participantId.value && it.expiresAt > world.clock }
                    .map { it.expiresAt } shouldContain world.clock.plus(Duration.ofHours(24))
                session.raw shouldStartWith "v1."
            }
        }

        context("[B5/c・d] 鍵の版のローテーション") {
            test("Given 版 1 で発行した資格 When 現在の版を 2 にする Then 旧版の資格は期限まで有効で、新しい資格は v2. で版 2 の行になる") {
                val world = World()
                val created = world.createGame()
                val old = world.join(created, "旧版の参加者", "join-old")
                world.rotateKeys(2, 1 to CREDENTIAL_KEY_V1, 2 to CREDENTIAL_KEY_V2)

                val fresh = world.join(created, "新版の参加者", "join-new")

                old.credential shouldStartWith "v1."
                fresh.credential shouldStartWith "v2."
                fresh.recovery shouldStartWith "v2."
                world.store.browserSessions.values
                    .map { it.keyVersion }
                    .toSet() shouldBe setOf(1, 2)
                world.store.credentials.values
                    .filter { it.subjectId == fresh.participantId.value }
                    .map { it.keyVersion } shouldBe listOf(2)
                world.ports.snapshotCredential(created.gameId, old.credential) shouldBe true
                world.ports.snapshotCredential(created.gameId, fresh.credential) shouldBe true
                world.recoveredSession(created.gameId, old.recovery, "recover-old-version").raw shouldStartWith "v2."
            }

            test("Given 版 1 の鍵を設定から外した When 旧版の資格で操作・復帰する Then どちらも app.unauthorized。現行版の資格は有効") {
                val world = World()
                val created = world.createGame()
                val old = world.join(created, "旧版の参加者", "join-old")
                world.rotateKeys(2, 2 to CREDENTIAL_KEY_V2)
                val fresh = world.join(created, "新版の参加者", "join-new")

                world.ports.snapshotCredential(created.gameId, old.credential) shouldBe false
                world.recover(created.gameId, old.recovery, "recover-dropped").err() shouldBe AppFailure.Unauthorized
                world.ports.snapshotCredential(created.gameId, fresh.credential) shouldBe true
                world.recover(created.gameId, fresh.recovery, "recover-fresh").ok()
            }
        }

        context("[B5/e・f] 別の種類・別のゲームの資格と、失敗の理由を区別しないこと") {
            test("Given ブラウザセッションの値と復帰資格の値 When 互いの用途に使う Then どちらも app.unauthorized（別のダイジェスト・別の表）") {
                val world = World()
                val game = world.started()
                val seat = game.seats[Role.RETAILER]

                world.save(game, Role.RETAILER, seat.recovery, "recovery-as-session").err() shouldBe
                    AppFailure.Unauthorized
                world.recover(game.gameId, seat.credential, "session-as-recovery").err() shouldBe
                    AppFailure.Unauthorized
                world.ports.snapshotCredential(game.gameId, seat.recovery) shouldBe false
            }

            test("Given 別のゲームの復帰資格 When このゲームへの復帰に使う Then app.unauthorized（存在を明かさない）") {
                val world = World()
                val game = world.started(tag = "a")
                val other = world.started(tag = "b")

                world.recover(game.gameId, other.seats[Role.RETAILER].recovery, "foreign").err() shouldBe
                    AppFailure.Unauthorized
            }

            test("Given 無い・不明・版の無い・知らない版・失効・期限切れの復帰資格 When 復帰する Then すべて同じ失敗で、冪等記録を検索しない") {
                val world = World()
                val game = world.started()
                val revoked = game.seats[Role.FACTORY]
                val expired = game.seats[Role.RETAILER]
                world.revoke(game, Role.FACTORY).ok()
                world.clock = T0.plus(Duration.ofDays(31))
                world.clearCalls()

                val results =
                    listOf(
                        null,
                        "not-a-credential",
                        "v1.unknown-token",
                        "v7.future-version",
                        revoked.recovery,
                        expired.recovery,
                    ).mapIndexed { i, credential -> world.recover(game.gameId, credential, "reason-$i") }

                results.forEach { it.err() shouldBe AppFailure.Unauthorized }
                world.calls shouldNotContain "idempotency.find"
                world.calls shouldNotContain "events.append"
            }
        }

        context("[B5/4.3] 資格の行の変更は、対応するイベントと同じトランザクション（イベントなしに起きない）") {
            test("Given 失効 When 行を見る Then 失効した行の主体は CredentialRevoked の主体と同じで、そのセッションの行は消えている") {
                val world = World()
                val game = world.started()

                world.revoke(game, Role.RETAILER).ok()

                val revokedEvents = world.store.payloads<GameEvent.CredentialRevoked>(game.gameId, StreamType.GAME)
                revokedEvents.map { it.subject } shouldBe listOf(game.subject(Role.RETAILER))
                val retailerId = game.seats[Role.RETAILER].participantId.value
                world.store.credentials.values
                    .filter { it.revoked }
                    .map { it.subjectId } shouldBe listOf(retailerId)
                world.store.browserSessions.values
                    .filter { it.subjectId == retailerId }
                    .shouldBeEmpty()
                world.store.browserSessions.size shouldBe 4
            }

            test("Given 失効の途中で投影が失敗する When 失効する Then トランザクションごと取り消され、資格の行もイベントも変わらない") {
                val world = World()
                val game = world.started()
                val credentialsBefore = world.store.credentials
                val sessionsBefore = world.store.browserSessions
                val eventsBefore = world.gameEvents(game.gameId)
                world.failProjection = true

                val result = world.revoke(game, Role.RETAILER)

                (result.err() is AppFailure.Persistence) shouldBe true
                world.store.credentials shouldBe credentialsBefore
                world.store.browserSessions shouldBe sessionsBefore
                world.gameEvents(game.gameId) shouldBe eventsBefore
            }

            test("Given 失効の途中で周辺ストアが失敗する When 失効する Then イベントも取り消され、資格は有効のまま") {
                val world = World()
                val game = world.started()
                val eventsBefore = world.gameEvents(game.gameId)
                world.failPeripheral = true

                val result = world.revoke(game, Role.RETAILER)

                (result.err() is AppFailure.Persistence) shouldBe true
                world.gameEvents(game.gameId) shouldBe eventsBefore
                world.failPeripheral = false
                world.save(game, Role.RETAILER, game.seats[Role.RETAILER].credential, "still-valid").ok()
            }

            test("Given 失効済み When もう一度失効する Then game.credential_already_revoked で、イベントも行も増えない") {
                val world = World()
                val game = world.started()
                world.revoke(game, Role.RETAILER, "first").ok()
                val eventsBefore = world.gameEvents(game.gameId)
                val credentialsBefore = world.store.credentials

                world.revoke(game, Role.RETAILER, "second").domainCode() shouldBe "game.credential_already_revoked"

                world.gameEvents(game.gameId) shouldBe eventsBefore
                world.store.credentials shouldBe credentialsBefore
            }

            test("Given 失効した資格 When 再発行する Then 新しい復帰資格（別の値）が一度だけ返り、古い復帰資格は使えず、新しいものは使える") {
                val world = World()
                val game = world.started()
                val seat = game.seats[Role.RETAILER]
                world.revoke(game, Role.RETAILER).ok()

                val reissued = checkNotNull(world.reissue(game, Role.RETAILER).ok().recovery)

                (reissued.raw == seat.recovery) shouldBe false
                reissued.raw shouldStartWith "v1."
                world.recover(game.gameId, seat.recovery, "old-recovery").err() shouldBe AppFailure.Unauthorized
                val session = checkNotNull(world.recover(game.gameId, reissued.raw, "new-recovery").ok().issued)
                world.save(game, Role.RETAILER, session.raw, "after-reissue-recover").ok()
                world.store.payloads<GameEvent.CredentialReissued>(game.gameId, StreamType.GAME).size shouldBe 1
            }

            test("Given 有効な資格 When 再発行しようとする Then game.credential_not_revoked で、新しい資格の行は作られない") {
                val world = World()
                val game = world.started()
                val credentialsBefore = world.store.credentials

                world.reissue(game, Role.RETAILER).domainCode() shouldBe "game.credential_not_revoked"

                world.store.credentials shouldBe credentialsBefore
            }

            test("Given 失効の再発行 When 行を見る Then 再発行した資格の期限は再発行の時刻から 30 日。生の値はどの行にも無い") {
                val world = World()
                val game = world.started()
                val seat = game.seats[Role.RETAILER]
                world.revoke(game, Role.RETAILER).ok()
                world.clock = T0.plusSeconds(600)

                val reissued = checkNotNull(world.reissue(game, Role.RETAILER).ok().recovery)

                val digest = CredentialDigest.of(CREDENTIAL_KEY_V1, reissued.raw)
                val expected = T0.plusSeconds(600).plus(Duration.ofDays(30))
                world.store.credentials
                    .getValue(digest)
                    .expiresAt shouldBe expected
                world.store.credentials.keys shouldNotContain reissued.raw
                world.store.credentials.keys shouldNotContain seat.recovery
            }
        }

        context("[B5/4.2] 資格の発行（作成・参加）") {
            test("Given ゲームの作成 When 資格を発行する Then ブラウザセッションと復帰資格は別の値・別のダイジェストで、期限は設定値") {
                val world = World()

                val outcome = world.ports.createGame(CreateGameInput(3, listOf(4, 4, 4), 90), meta("create-1")).ok()
                val session = checkNotNull(outcome.issued)
                val recovery = checkNotNull(outcome.recovery)

                (session.raw == recovery.raw) shouldBe false
                session.raw shouldStartWith "v1."
                recovery.raw shouldStartWith "v1."
                val sessionDigest = CredentialDigest.of(CREDENTIAL_KEY_V1, session.raw)
                val recoveryDigest = CredentialDigest.of(CREDENTIAL_KEY_V1, recovery.raw)
                val sessionRow = world.store.browserSessions.getValue(sessionDigest)
                val recoveryRow = world.store.credentials.getValue(recoveryDigest)
                sessionRow.expiresAt shouldBe T0.plus(Duration.ofHours(24))
                recoveryRow.expiresAt shouldBe T0.plus(Duration.ofDays(90))
                val sharedDigests = world.store.browserSessions.keys intersect world.store.credentials.keys
                sharedDigests.shouldBeEmpty()
                sessionRow.keyVersion shouldBe 1
                recoveryRow.keyVersion shouldBe 1
            }

            test("Given 参加 When 資格を発行する Then ブラウザセッションの期限は 24 時間、復帰資格の期限は 30 日（どちらも設定値）") {
                val world = World()
                val created = world.createGame()

                val seat = world.join(created, "田中", "join-1")

                world.store.browserSessions
                    .getValue(CredentialDigest.of(CREDENTIAL_KEY_V1, seat.credential))
                    .expiresAt shouldBe T0.plus(Duration.ofHours(24))
                world.store.credentials
                    .getValue(CredentialDigest.of(CREDENTIAL_KEY_V1, seat.recovery))
                    .expiresAt shouldBe T0.plus(Duration.ofDays(30))
                (seat.credential == seat.recovery) shouldBe false
                world.store.credentials
                    .getValue(CredentialDigest.of(CREDENTIAL_KEY_V1, seat.recovery))
                    .revoked shouldBe false
                world.attempts("authenticateRecovery") shouldBe 0
            }
        }
    })

/** 状況の取得（`snapshot`）が、その資格を認証するか。投影は無くてもよい（認証の結果だけを見る）。 */
private fun Ports.snapshotCredential(
    gameId: GameId,
    credential: String,
): Boolean =
    runBlocking {
        val at = now()
        val digest = settings.credentialKeys.digest(credential)?.digest
        digest != null &&
            events
                .transaction { tx -> peripheral.authenticate(tx, digest, at) }
                .getOrNull()
                ?.gameId == gameId
    }
