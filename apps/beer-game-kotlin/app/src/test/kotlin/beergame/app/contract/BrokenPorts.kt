package beergame.app.contract

import arrow.core.left
import beergame.application.AppFailure
import beergame.application.ObservationReader
import beergame.application.Ports
import beergame.application.ProjectionReader
import beergame.application.Readers
import beergame.application.Stores
import java.util.concurrent.atomic.AtomicBoolean

/*
 * 契約テストのために、ポートをわざと壊す。[broken] が true の間だけ壊れる（準備は、壊す前に済ませる）。
 * 壊れ方は、本番で起きる 2 通り: 予期しない例外（500）と、追記の競合が続いて再試行の上限に達する（503）。
 */

private const val SECRET_MESSAGE = "契約テストのためにわざと壊した（接続文字列 postgres://app:secret@db/x）"

private fun explode(): Nothing = error(SECRET_MESSAGE)

/** 永続化の入口（読み・追記・認証・参加コードの検索・投影の読み）が、すべて例外になる。 */
internal fun throwingPorts(
    ports: Ports,
    broken: AtomicBoolean,
): Ports {
    val stores = ports.stores
    val events = stores.events
    val peripheral = stores.peripheral
    return Ports(
        ports.generators,
        Stores(
            events =
                events.copy(
                    read = { tx, id, stream -> if (broken.get()) explode() else events.read(tx, id, stream) },
                    append = { tx, expected, new -> if (broken.get()) explode() else events.append(tx, expected, new) },
                ),
            project = stores.project,
            idempotency = stores.idempotency,
            peripheral =
                peripheral.copy(
                    authenticate = { tx, digest, now ->
                        if (broken.get()) explode() else peripheral.authenticate(tx, digest, now)
                    },
                    findGameByJoinCode = { tx, code ->
                        if (broken.get()) explode() else peripheral.findGameByJoinCode(tx, code)
                    },
                ),
            attempts = stores.attempts,
            readers =
                Readers(
                    ProjectionReader { id -> if (broken.get()) explode() else stores.reader.read(id) },
                    stores.observation?.let { observation ->
                        ObservationReader { id -> if (broken.get()) explode() else observation.read(id) }
                    },
                ),
        ),
        ports.lock,
        ports.notifier,
        ports.settings,
    )
}

/** 追記が、常に競合で失敗する（再試行の上限まで繰り返して、`RetryExhausted` になる）。 */
internal fun conflictingPorts(
    ports: Ports,
    broken: AtomicBoolean,
): Ports {
    val stores = ports.stores
    val events = stores.events
    return Ports(
        ports.generators,
        Stores(
            events =
                events.copy(
                    append = { tx, expected, new ->
                        if (broken.get()) AppFailure.ConcurrencyConflict.left() else events.append(tx, expected, new)
                    },
                ),
            project = stores.project,
            idempotency = stores.idempotency,
            peripheral = stores.peripheral,
            attempts = stores.attempts,
            readers = stores.readers,
        ),
        ports.lock,
        ports.notifier,
        ports.settings,
    )
}
