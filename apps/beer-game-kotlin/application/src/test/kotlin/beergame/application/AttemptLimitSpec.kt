package beergame.application

import arrow.core.Either
import beergame.domain.GameId
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlinx.coroutines.runBlocking
import java.time.Duration

/*
 * 参加・復帰の専用のレート制限（B5 Step 5。NF-S11・NF-S19。総当たりの否定テストを先に書いた）。
 * 守ること: 同じ接続元の連続した失敗が上限で 429（RateLimited）。成功は窓に数えない。形式が不正な本文（入力の検証の失敗）は
 * 窓に数えない。上限に達した接続元は、参加コード・復帰資格の検査を始めない。ほかの接続元は影響を受けない。
 * 窓は永続化（DB）にあり、複数のインスタンスで合算される（その確認は永続化の契約テスト）。
 */

private val ATTACKER = AttemptSource.of("203.0.113.7")
private val BYSTANDER = AttemptSource.of("198.51.100.9")
private val LIMIT = TEST_ATTEMPT_POLICY.maxFailures
private val WINDOW = TEST_ATTEMPT_POLICY.window

private fun World.joinFrom(
    source: AttemptSource?,
    code: String,
    key: String,
    name: String = "参加者",
): Either<AppFailure, CommandOutcome> =
    runBlocking {
        ports.joinGame(JoinGameInput(code, name), meta(key, source = source))
    }

/** 存在しない（形式は正しい）参加コードを、[times] 回送る。すべて同じ失敗になる。 */
private fun World.guessCodes(
    source: AttemptSource?,
    times: Int,
) {
    repeat(times) { i ->
        joinFrom(source, "JOIN-9${i.toString().padStart(3, '0')}", "guess-$i").domainCode() shouldBe
            "game.invitation_invalid"
    }
}

private fun World.recoverFrom(
    source: AttemptSource?,
    gameId: GameId,
    recovery: String?,
    key: String,
): Either<AppFailure, CommandOutcome> = runBlocking { ports.recoverParticipation(gameId, meta(key, recovery, source)) }

private fun World.guessRecoveries(
    source: AttemptSource?,
    gameId: GameId,
    times: Int,
) {
    repeat(times) { i ->
        recoverFrom(source, gameId, "v1.guess-$i", "recover-guess-$i").err() shouldBe AppFailure.Unauthorized
    }
}

private fun World.failureCount(scope: AttemptScope): Int =
    store.attempts
        .filterKeys { it.scope == scope }
        .values
        .sum()

class AttemptLimitSpec :
    FunSpec({
        context("[5.1] 参加（join）の総当たり") {
            test("Given 上限まで失敗した接続元 When 次の参加を送る Then RateLimited（残りの秒数つき）で、参加コードの検査も追記もしない") {
                val world = World()
                val game = world.createGame()
                world.guessCodes(ATTACKER, LIMIT)
                world.clearCalls()

                // 正しい参加コードでも、上限の後は検査せずに拒否する（総当たりの当たりを知らせない）
                val blocked = world.joinFrom(ATTACKER, game.joinCode, "after-limit")

                blocked.err() shouldBe AppFailure.RateLimited(WINDOW.seconds.toInt())
                world.calls shouldNotContain "findGameByJoinCode"
                world.calls shouldNotContain "idempotency.find"
                world.calls shouldNotContain "events.append"
            }

            test("Given 上限に達した接続元 When 別の接続元が正しい参加コードで参加する Then 影響を受けず参加できる") {
                val world = World()
                val game = world.createGame()
                world.guessCodes(ATTACKER, LIMIT)

                world.joinFrom(BYSTANDER, game.joinCode, "bystander-join").ok()
            }

            test("Given 形式が不正な参加コードと不明な参加コード When 送る Then どちらも同じ失敗で、どちらも窓に数える") {
                val world = World()
                world.createGame()

                world.joinFrom(ATTACKER, "x", "malformed").domainCode() shouldBe "game.invitation_invalid"
                world.joinFrom(ATTACKER, "JOIN-9999", "unknown").domainCode() shouldBe "game.invitation_invalid"

                world.failureCount(AttemptScope.JOIN) shouldBe 2
            }

            test("Given 上限に達した接続元 When 窓が過ぎる Then 参加できる。窓の残りの秒数は時刻に応じて減る") {
                val world = World()
                val game = world.createGame()
                world.guessCodes(ATTACKER, LIMIT)

                world.clock = T0.plusSeconds(100)
                world.joinFrom(ATTACKER, game.joinCode, "in-window").err() shouldBe
                    AppFailure.RateLimited(WINDOW.seconds.toInt() - 100)

                world.clock = T0.plus(WINDOW)
                world.joinFrom(ATTACKER, game.joinCode, "next-window").ok()
            }

            test("Given 成功した参加 When 繰り返す Then 窓に数えない（上限を超えて成功し続けられる）") {
                val world = World()
                val game = world.createGame()

                repeat(LIMIT + 3) { i ->
                    world.joinFrom(ATTACKER, game.joinCode, "join-$i", "参加者$i").ok()
                }

                world.failureCount(AttemptScope.JOIN) shouldBe 0
            }

            test("Given 形式が不正な本文（表示名が空）When 繰り返し送る Then 入力の誤りで、窓に数えず、窓の保存にも触れない") {
                val world = World()
                val game = world.createGame()
                world.clearCalls()

                repeat(LIMIT + 3) { i ->
                    world
                        .joinFrom(
                            ATTACKER,
                            game.joinCode,
                            "empty-name-$i",
                            "",
                        ).err()
                        .shouldBeInstanceOf<AppFailure.Invalid>()
                }

                world.calls shouldNotContain "attempts.charge"
                world.store.attempts.size shouldBe 0
            }

            test("Given 受付が終わったゲーム When 正しい参加コードで繰り返す Then 認可の失敗ではないので窓に数えない") {
                val world = World()
                val game = world.started()

                repeat(LIMIT + 2) { i ->
                    world.joinFrom(ATTACKER, game.created.joinCode, "late-$i").domainCode() shouldBe
                        "game.not_preparing"
                }

                world.failureCount(AttemptScope.JOIN) shouldBe 0
            }

            test("Given 前の窓の行 When 新しい窓で最初の失敗を記録する Then 前の窓の行を掃除する（表が増え続けない）") {
                val world = World()
                world.createGame()
                world.guessCodes(ATTACKER, 1)
                val first =
                    world.store.attempts.keys
                        .single()

                world.clock = T0.plus(WINDOW.multipliedBy(3))
                world.joinFrom(ATTACKER, "JOIN-9999", "later").domainCode() shouldBe "game.invitation_invalid"

                world.calls shouldContain "attempts.purge"
                world.store.attempts.keys
                    .map { it.start }
                    .shouldNotContain(first.start)
                world.store.attempts.size shouldBe 1
            }

            test("Given 窓を保存できない When 参加する Then 通さず（閉じる側に倒す）、永続化の失敗を返す") {
                val world = World()
                val game = world.createGame()
                world.failAttempts = true
                world.clearCalls()

                world.joinFrom(ATTACKER, game.joinCode, "store-down").err().shouldBeInstanceOf<AppFailure.Persistence>()

                world.calls shouldNotContain "findGameByJoinCode"
                world.calls shouldNotContain "events.append"
            }

            test("Given 接続元が分からない呼び出し（HTTP の外） When 参加する Then 窓には触れない") {
                val world = World()
                val game = world.createGame()
                world.clearCalls()

                world.joinFrom(null, game.joinCode, "no-source").ok()

                world.calls shouldNotContain "attempts.charge"
            }
        }

        context("[5.1] 復帰（recover）の総当たり") {
            test("Given 上限まで無効な復帰資格を送った接続元 When 正しい復帰資格を送る Then RateLimited で、復帰資格の検査もしない") {
                val world = World()
                val game = world.prepared()
                val seat = game.seats[beergame.domain.Role.RETAILER]
                world.guessRecoveries(ATTACKER, game.gameId, LIMIT)
                world.clearCalls()

                val blocked = world.recoverFrom(ATTACKER, game.gameId, seat.recovery, "recover-after-limit")

                blocked.err() shouldBe AppFailure.RateLimited(WINDOW.seconds.toInt())
                world.calls shouldNotContain "authenticateRecovery"
                world.calls shouldNotContain "idempotency.find"
                world.calls shouldNotContain "events.append"
            }

            test("Given 上限に達した接続元 When 別の接続元が正しい復帰資格で復帰する Then 影響を受けず復帰できる") {
                val world = World()
                val game = world.prepared()
                val seat = game.seats[beergame.domain.Role.RETAILER]
                world.guessRecoveries(ATTACKER, game.gameId, LIMIT)

                world.recoverFrom(BYSTANDER, game.gameId, seat.recovery, "bystander-recover").ok()
            }

            test("Given 無い・形式違い・不明・失効・別のゲームの復帰資格 When 送る Then どれも同じ失敗（Unauthorized）で、どれも窓に数える") {
                val world = World(testSettings(attempts = AttemptPolicy.of(10, WINDOW).ok()))
                val game = world.prepared()
                val other = world.createGame("other")
                val seat = game.seats[beergame.domain.Role.RETAILER]
                val revokedSubject = beergame.domain.CredentialSubject.Participant(seat.participantId)
                runBlocking {
                    world.ports.revokeCredential(
                        game.gameId,
                        revokedSubject,
                        meta("revoke", game.facilitator),
                    )
                }.ok()

                listOf(
                    null,
                    "not-a-credential",
                    "v1.${"A".repeat(43)}",
                    seat.recovery,
                    other.facilitatorRecovery,
                ).forEachIndexed { i, recovery ->
                    world.recoverFrom(ATTACKER, game.gameId, recovery, "reason-$i").err() shouldBe
                        AppFailure.Unauthorized
                }

                world.failureCount(AttemptScope.RECOVER) shouldBe 5
            }

            test("Given 成功した復帰 When 繰り返す Then 窓に数えない") {
                val world = World()
                val game = world.prepared()
                val seat = game.seats[beergame.domain.Role.RETAILER]

                repeat(LIMIT + 3) { i ->
                    world.recoverFrom(ATTACKER, game.gameId, seat.recovery, "recover-$i").ok()
                }

                world.failureCount(AttemptScope.RECOVER) shouldBe 0
            }

            test("Given 参加で上限に達した接続元 When 復帰する Then 復帰の窓は別なので、復帰は検査される（参加と復帰は別に数える）") {
                val world = World()
                val game = world.prepared()
                val seat = game.seats[beergame.domain.Role.RETAILER]
                world.guessCodes(ATTACKER, LIMIT)

                world.recoverFrom(ATTACKER, game.gameId, seat.recovery, "recover-after-join-limit").ok()
                world.failureCount(AttemptScope.JOIN) shouldBe LIMIT
            }
        }

        test("[5.1] 窓の上限と長さ When 設定する Then 正の値だけ（0 以下は設定の誤り）") {
            AttemptPolicy.of(10, Duration.ofMinutes(10)).isRight() shouldBe true
            AttemptPolicy.of(0, Duration.ofMinutes(10)).isLeft() shouldBe true
            AttemptPolicy.of(10, Duration.ZERO).isLeft() shouldBe true
            AttemptPolicy.of(10, Duration.ofMillis(500)).isLeft() shouldBe true
            AttemptPolicy.of(10, Duration.ofSeconds(1)).isRight() shouldBe true
        }
    })
