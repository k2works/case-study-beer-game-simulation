package beergame.persistence

import arrow.core.Either
import arrow.core.raise.either
import beergame.application.AppFailure
import beergame.application.VersionNotice
import beergame.domain.GameId
import beergame.domain.StreamType
import beergame.domain.StreamVersion
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue

private const val WAIT_MILLIS = 5_000L

private fun newGameId() = GameId(UUID.randomUUID())

/** ポート `ProjectionLock` の契約。H2 版（プロセス内の読み書きロック）と PostgreSQL 版（アドバイザリロック）の両方で実行する。 */
fun FunSpec.projectionLockContract(fixture: () -> Fixture) {
    sharedLockContract(fixture)
    exclusiveLockContract(fixture)
    releaseLockContract(fixture)
}

private fun FunSpec.sharedLockContract(fixture: () -> Fixture) {
    test("[7.4 契約] Given 共有を保持中のトランザクション When 別のトランザクションが共有を取る Then 待たずに取れる") {
        val fx = fixture()
        val game = newGameId()
        coroutineScope {
            val acquired = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val holder =
                async {
                    fx.tx { tx ->
                        either {
                            fx.persistence.lock
                                .acquireShared(tx, game)
                                .bind()
                            acquired.complete(Unit)
                            release.await()
                        }
                    }
                }
            acquired.await()

            val second = withTimeout(WAIT_MILLIS) { fx.tx { tx -> fx.persistence.lock.acquireShared(tx, game) } }

            second shouldBe Either.Right(Unit)
            release.complete(Unit)
            holder.await().orFail()
        }
    }
}

private fun FunSpec.exclusiveLockContract(fixture: () -> Fixture) {
    test("[7.4 契約] Given 共有を保持中 When 排他を取る Then 待ちの上限で RetryExhausted を返す") {
        val fx = fixture()
        val game = newGameId()
        coroutineScope {
            val acquired = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val holder =
                async {
                    fx.tx { tx ->
                        either {
                            fx.persistence.lock
                                .acquireShared(tx, game)
                                .bind()
                            acquired.complete(Unit)
                            release.await()
                        }
                    }
                }
            acquired.await()

            val exclusive = withTimeout(WAIT_MILLIS) { fx.tx { tx -> fx.persistence.lock.acquireExclusive(tx, game) } }

            exclusive.leftOrFail() shouldBe AppFailure.RetryExhausted
            release.complete(Unit)
            holder.await().orFail()
        }
    }

    test("[7.4 契約] Given 排他を保持中 When 共有を取る Then 排他のトランザクションの終了を待ってから取れる") {
        val fx = fixture()
        val game = newGameId()
        val order = ConcurrentLinkedQueue<String>()
        coroutineScope {
            val acquired = CompletableDeferred<Unit>()
            val holder =
                async {
                    fx.tx { tx ->
                        either {
                            fx.persistence.lock
                                .acquireExclusive(tx, game)
                                .bind()
                            acquired.complete(Unit)
                            delay(100)
                            order.add("排他の終了")
                        }
                    }
                }
            acquired.await()

            val shared = withTimeout(WAIT_MILLIS) { fx.tx { tx -> fx.persistence.lock.acquireShared(tx, game) } }
            order.add("共有を取得")

            shared shouldBe Either.Right(Unit)
            holder.await().orFail()
        }
        order.toList() shouldContainExactly listOf("排他の終了", "共有を取得")
    }
}

private fun FunSpec.releaseLockContract(fixture: () -> Fixture) {
    test("[7.4 契約] Given ROLLBACK で終わった排他 When 共有を取る Then 解放されていて取れる") {
        val fx = fixture()
        val game = newGameId()
        val first =
            fx.tx { tx ->
                either<AppFailure, Unit> {
                    fx.persistence.lock
                        .acquireExclusive(tx, game)
                        .bind()
                    raise(AppFailure.Unauthorized)
                }
            }
        first.leftOrFail() shouldBe AppFailure.Unauthorized

        val second = withTimeout(WAIT_MILLIS) { fx.tx { tx -> fx.persistence.lock.acquireShared(tx, game) } }

        second shouldBe Either.Right(Unit)
    }

    test("[7.4 契約] Given あるゲームの排他 When 別のゲームの共有を取る Then 待たずに取れる（ゲームごと）") {
        val fx = fixture()
        val gameA = newGameId()
        val gameB = newGameId()
        coroutineScope {
            val acquired = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val holder =
                async {
                    fx.tx { tx ->
                        either {
                            fx.persistence.lock
                                .acquireExclusive(tx, gameA)
                                .bind()
                            acquired.complete(Unit)
                            release.await()
                        }
                    }
                }
            acquired.await()

            val other = withTimeout(WAIT_MILLIS) { fx.tx { tx -> fx.persistence.lock.acquireShared(tx, gameB) } }

            other shouldBe Either.Right(Unit)
            release.complete(Unit)
            holder.await().orFail()
        }
    }
}

private fun notice(
    game: GameId,
    version: Long,
) = VersionNotice(game, StreamType.GAME, StreamVersion.of(version).orFail())

/** ポート `ChangeNotifier` の契約。H2 版（プロセス内のイベント）と PostgreSQL 版（pg_notify と LISTEN）の両方で実行する。 */
fun FunSpec.changeNotifierContract(fixture: () -> Fixture) {
    commitNoticeContract(fixture)
    rollbackNoticeContract(fixture)
    unsubscribeNoticeContract(fixture)
}

private fun FunSpec.commitNoticeContract(fixture: () -> Fixture) {
    test("[7.5 契約] Given 購読者 When 追記と同じトランザクションで publish してコミットする Then 通知が届く") {
        val fx = fixture()
        val game = newGameId()
        val sink = Channel<VersionNotice>(Channel.UNLIMITED)
        coroutineScope {
            val subscriber =
                launch {
                    fx.persistence.notifier
                        .subscribe()
                        .collect { sink.send(it) }
                }
            delay(200)

            fx
                .tx { tx ->
                    either {
                        fx.persistence.notifier
                            .publish(
                                tx,
                                listOf(notice(game, 3)),
                            ).mapLeft { AppFailure.Persistence(it) }
                            .bind()
                    }
                }.orFail()

            withTimeout(WAIT_MILLIS) { sink.receive() } shouldBe notice(game, 3)
            subscriber.cancelAndJoin()
        }
    }
}

private fun FunSpec.rollbackNoticeContract(fixture: () -> Fixture) {
    test("[7.5 契約] Given 購読者 When publish した後に ROLLBACK する Then 通知は届かない（その後のコミットの通知だけが届く）") {
        val fx = fixture()
        val game = newGameId()
        val sink = Channel<VersionNotice>(Channel.UNLIMITED)
        coroutineScope {
            val subscriber =
                launch {
                    fx.persistence.notifier
                        .subscribe()
                        .collect { sink.send(it) }
                }
            delay(200)

            fx
                .tx { tx ->
                    either<AppFailure, Unit> {
                        fx.persistence.notifier
                            .publish(
                                tx,
                                listOf(notice(game, 1)),
                            ).mapLeft { AppFailure.Persistence(it) }
                            .bind()
                        raise(AppFailure.Unauthorized)
                    }
                }.leftOrFail() shouldBe AppFailure.Unauthorized
            fx
                .tx { tx ->
                    either {
                        fx.persistence.notifier
                            .publish(
                                tx,
                                listOf(notice(game, 2)),
                            ).mapLeft { AppFailure.Persistence(it) }
                            .bind()
                    }
                }.orFail()

            withTimeout(WAIT_MILLIS) { sink.receive() } shouldBe notice(game, 2)
            withTimeoutOrNull(300) { sink.receive() } shouldBe null
            subscriber.cancelAndJoin()
        }
    }
}

private fun FunSpec.unsubscribeNoticeContract(fixture: () -> Fixture) {
    test("[7.5 契約] Given 購読を解除した When コミットする Then 解除した購読者には届かない") {
        val fx = fixture()
        val game = newGameId()
        val sink = Channel<VersionNotice>(Channel.UNLIMITED)
        coroutineScope {
            val subscriber =
                launch {
                    fx.persistence.notifier
                        .subscribe()
                        .collect { sink.send(it) }
                }
            delay(200)
            subscriber.cancelAndJoin()

            fx
                .tx { tx ->
                    either {
                        fx.persistence.notifier
                            .publish(
                                tx,
                                listOf(notice(game, 9)),
                            ).mapLeft { AppFailure.Persistence(it) }
                            .bind()
                    }
                }.orFail()

            withTimeoutOrNull(500) { sink.receive() } shouldBe null
        }
    }

    test("[7.5 契約] Given 稼働中の通知 When isAlive を見る Then true") {
        fixture().persistence.notifier.isAlive() shouldBe true
    }
}
