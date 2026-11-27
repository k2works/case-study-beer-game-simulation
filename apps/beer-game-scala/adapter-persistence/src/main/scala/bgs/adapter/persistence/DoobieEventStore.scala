package bgs.adapter.persistence

import bgs.application.{AppFailure, EventStore, StreamRead}
import bgs.domain.*
import bgs.adapter.persistence.EventCodecs.given
import cats.syntax.all.*
import doobie.*
import doobie.implicits.*
import doobie.postgres.implicits.*
import io.circe.syntax.*
import io.circe.{Decoder, Encoder}

import java.nio.charset.StandardCharsets
import java.sql.SQLException
import java.time.Instant
import java.util.UUID

/** イベントストアの doobie 実装（H2 と PostgreSQL で共通）。ストリームは `game` と `session` の 2 本。
  * 追記は、期待する版（読んだ時点の版）が現在と同じときだけ成功する（楽観的並行制御）。 同じ版への同時の追記は、`uq_events_stream_version`（と
  * `pk_game_roots`）の一意制約違反で、一方だけが成功する。
  */
object DoobieEventStore:

  private val UniqueViolation = "23505"

  /** event_id は、ゲーム・ストリーム・版から決める（乱数・時計を使わない。同じ入力から同じ値）。 */
  private def eventId(gameId: GameId, stream: String, version: Long): UUID =
    UUID.nameUUIDFromBytes(s"${gameId.value}/$stream/$version".getBytes(StandardCharsets.UTF_8))

  def game: EventStore[GameEvent] = store("game", _.name)
  def session: EventStore[SessionEvent] = store("session", _.name)

  private def store[E: Encoder: Decoder](stream: String, eventType: E => String): EventStore[E] =
    EventStore(
      read = gameId => read(stream, gameId),
      append =
        (gameId, expected, events, at) => append(stream, eventType, gameId, expected, events, at)
    )

  private def currentVersion(stream: String, gameId: GameId): ConnectionIO[Long] =
    sql"select coalesce(max(stream_version), 0) from events where game_id = ${gameId.value} and stream_type = $stream"
      .query[Long]
      .unique

  private def read[E: Decoder](stream: String, gameId: GameId): ConnectionIO[StreamRead[E]] =
    sql"""select stream_version, schema_version, event_type, payload, occurred_at from events
          where game_id = ${gameId.value} and stream_type = $stream order by stream_version"""
      .query[(Long, Int, String, String, Instant)]
      .to[List]
      .flatMap { rows =>
        rows.traverse((_, schemaVersion, eventType, payload, _) =>
          Upcasters
            .upcast(eventType, schemaVersion, payload)
            .flatMap(json => json.as[E].leftMap(_.getMessage))
            .leftMap(message => new IllegalStateException(message))
        ) match
          case Right(events) =>
            StreamRead(
              events,
              StreamVersion.of(rows.lastOption.fold(0L)(_._1)),
              rows.map(_._5),
              rows.map(_._1)
            ).pure[ConnectionIO]
          case Left(error) => FC.raiseError[StreamRead[E]](error)
      }

  private def append[E: Encoder](
      stream: String,
      eventType: E => String,
      gameId: GameId,
      expected: StreamVersion,
      events: List[E],
      at: Instant
  ): ConnectionIO[Either[AppFailure, StreamVersion]] =
    currentVersion(stream, gameId).flatMap { current =>
      if current != expected.value then Left(AppFailure.ConcurrencyConflict).pure[ConnectionIO]
      else
        val rootInsert: ConnectionIO[Int] =
          if stream == "game" && expected.value == 0L then
            sql"insert into game_roots (game_id) values (${gameId.value})".update.run
          else 0.pure[ConnectionIO]
        val inserts = events.zipWithIndex.traverse { (event, index) =>
          val version = expected.value + index + 1
          sql"""insert into events
                (event_id, game_id, stream_type, stream_version, schema_version, event_type, payload, occurred_at)
                values (${eventId(gameId, stream, version)}, ${gameId.value}, $stream, $version, 1,
                        ${eventType(event)}, ${event.asJson.noSpaces}, $at)""".update.run
        }
        (rootInsert *> inserts).attemptSql.map {
          case Right(_)    => Right(StreamVersion.of(expected.value + events.size))
          case Left(error) => Left(failureOf(error))
        }
    }

  private def failureOf(error: SQLException): AppFailure =
    if error.getSQLState == UniqueViolation then AppFailure.ConcurrencyConflict
    else AppFailure.Persistence(error.getMessage)
