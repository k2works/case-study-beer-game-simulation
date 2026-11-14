package beergame.persistence

import beergame.application.AppFailure
import beergame.application.IdempotencyKey
import beergame.application.StoredResponse
import beergame.domain.GameId
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import java.time.Duration
import java.time.Instant
import java.util.UUID

private val NOW: Instant = Instant.parse("2026-11-14T10:00:00Z")
private val DAY: Duration = Duration.ofHours(24)

private fun response(
    game: GameId,
    body: String = """{"versions":{"game":3,"session":null}}""",
    digest: String = "request-digest-1",
): StoredResponse = StoredResponse(game, digest, 200, body.toByteArray(), NOW.plus(DAY))

private fun randomKey(
    game: GameId,
    scope: String = "decision:RETAILER",
): IdempotencyKey = IdempotencyKey(game, scope, "key-" + UUID.randomUUID())

private suspend fun Fixture.newGame(): GameId = GameScript().create().also { appendScript(it) }.gameId

/** 冪等記録の契約。H2 と PostgreSQL の両方で実行する（PostgreSQL 固有の部分一意索引の直接の検証は PostgreSQL の統合テスト）。 */
fun FunSpec.idempotencyContract(fixture: () -> Fixture) {
    saveFindContract(fixture)
    encryptionContract(fixture)
    duplicateContract(fixture)
}

private fun FunSpec.saveFindContract(fixture: () -> Fixture) {
    test("[7.3] Given 保存した成功の応答 When 同じキーで探す Then 要求の digest と応答の本文をそのまま返す") {
        val fx = fixture()
        val game = fx.newGame()
        val key = randomKey(game)
        val stored = response(game)

        fx.tx { tx -> fx.persistence.idempotency.save(tx, key, stored, NOW) }.orFail()
        val found = fx.tx { tx -> fx.persistence.idempotency.find(tx, key, NOW.plusSeconds(1)) }.orFail()

        found shouldBe stored
    }

    test("[7.3] Given 24 時間後に失効する記録 When 失効の時刻に探す Then 期限切れとして見つからない") {
        val fx = fixture()
        val game = fx.newGame()
        val key = randomKey(game)
        fx.tx { tx -> fx.persistence.idempotency.save(tx, key, response(game), NOW) }.orFail()

        val justBefore =
            fx
                .tx { tx ->
                    fx.persistence.idempotency.find(
                        tx,
                        key,
                        NOW.plus(DAY).minusSeconds(1),
                    )
                }.orFail()
        val atExpiry = fx.tx { tx -> fx.persistence.idempotency.find(tx, key, NOW.plus(DAY)) }.orFail()

        justBefore shouldNotBe null
        atExpiry shouldBe null
    }

    test("[7.3] Given 期限切れの記録 When 同じキーで保存し直す Then 置き換えられる") {
        val fx = fixture()
        val game = fx.newGame()
        val key = randomKey(game)
        fx.tx { tx -> fx.persistence.idempotency.save(tx, key, response(game, digest = "old"), NOW) }.orFail()
        val later = NOW.plus(DAY).plusSeconds(5)

        fx
            .tx { tx ->
                fx.persistence.idempotency.save(
                    tx,
                    key,
                    StoredResponse(game, "new", 200, "x".toByteArray(), later.plus(DAY)),
                    later,
                )
            }.orFail()

        fx.tx { tx -> fx.persistence.idempotency.find(tx, key, later) }.orFail()?.requestDigest shouldBe "new"
    }
}

private fun FunSpec.encryptionContract(fixture: () -> Fixture) {
    test("[7.3] Given 保存した応答 When DB の列を直接読む Then 平文が残っていない（暗号化して保存する）") {
        val fx = fixture()
        val game = fx.newGame()
        val key = randomKey(game)
        val secret = "RAW-CREDENTIAL-VALUE-0123456789"
        fx.tx { tx -> fx.persistence.idempotency.save(tx, key, response(game, body = secret), NOW) }.orFail()

        val raw =
            fx
                .query(
                    "SELECT response FROM idempotency_records WHERE game_id = ? AND key_digest = ?",
                    game.value,
                    key.keyDigest,
                ) {
                    it.getBytes(1)
                }.single()

        String(raw, Charsets.ISO_8859_1).contains(secret) shouldBe false
        (raw.size > secret.length) shouldBe true
    }
}

private fun FunSpec.duplicateContract(fixture: () -> Fixture) {
    test("[7.3] Given 同じキー・同じ対象の記録 When もう一度保存する Then ConcurrencyConflict（pk_idempotency_records）") {
        val fx = fixture()
        val game = fx.newGame()
        val key = randomKey(game)
        fx.tx { tx -> fx.persistence.idempotency.save(tx, key, response(game), NOW) }.orFail()

        val second = fx.tx { tx -> fx.persistence.idempotency.save(tx, key, response(game), NOW) }

        second.leftOrFail() shouldBe AppFailure.ConcurrencyConflict
    }

    test("[7.3] Given 別のゲームで保存済みの create の記録 When 同じキーで別のゲームを作る Then ConcurrencyConflict（uq_idempotency_create）") {
        val fx = fixture()
        val firstGame = fx.newGame()
        val secondGame = fx.newGame()
        val digest = "create-" + UUID.randomUUID()
        val firstKey = IdempotencyKey(firstGame, IdempotencyKey.CREATE_SCOPE, digest)
        val secondKey = IdempotencyKey(secondGame, IdempotencyKey.CREATE_SCOPE, digest)
        fx.tx { tx -> fx.persistence.idempotency.save(tx, firstKey, response(firstGame), NOW) }.orFail()

        val second = fx.tx { tx -> fx.persistence.idempotency.save(tx, secondKey, response(secondGame), NOW) }

        second.leftOrFail() shouldBe AppFailure.ConcurrencyConflict
        val found = fx.tx { tx -> fx.persistence.idempotency.find(tx, secondKey, NOW) }.orFail()
        found?.gameId shouldBe firstGame
    }

    test("[7.3] Given 保存の後に Left を返す Then 冪等記録も取り消される（追記と同じトランザクション）") {
        val fx = fixture()
        val game = fx.newGame()
        val key = randomKey(game)

        val result =
            fx.tx { tx ->
                fx.persistence.idempotency
                    .save(tx, key, response(game), NOW)
                    .orFail()
                arrow.core.Either.Left(AppFailure.Unauthorized)
            }

        result.leftOrFail() shouldBe AppFailure.Unauthorized
        fx.tx { tx -> fx.persistence.idempotency.find(tx, key, NOW) }.orFail() shouldBe null
    }
}
