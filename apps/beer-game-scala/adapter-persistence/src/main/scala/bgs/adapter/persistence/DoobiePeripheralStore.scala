package bgs.adapter.persistence

import bgs.application.{IdempotentRecord, PeripheralStore}
import bgs.domain.*
import cats.syntax.all.*
import doobie.*
import doobie.implicits.*
import doobie.postgres.implicits.*

import java.util.UUID

/** 周辺ストアの doobie 実装（H2 と PostgreSQL で共通）。資格の値は持たず、ダイジェストだけを保存する。 */
object DoobiePeripheralStore:

  private val FacilitatorKind = "facilitator"
  private val ParticipantKind = "participant"

  private def kindAndId(subject: CredentialSubject): (String, UUID) = subject match
    case CredentialSubject.Facilitator(id) => (FacilitatorKind, id.value)
    case CredentialSubject.Participant(id) => (ParticipantKind, id.value)

  private def subjectOf(
      gameId: UUID,
      kind: String,
      subjectId: UUID
  ): Option[(GameId, CredentialSubject)] =
    if kind == FacilitatorKind then
      Some(GameId(gameId) -> CredentialSubject.Facilitator(GameId(gameId)))
    else if kind == ParticipantKind then
      Some(GameId(gameId) -> CredentialSubject.Participant(ParticipantId(subjectId)))
    else None

  def apply(): PeripheralStore =
    PeripheralStore(
      registerJoinCode = (code, gameId) =>
        sql"insert into game_join_codes (join_code, game_id) values (${code.value}, ${gameId.value})".update.run.void,
      findGame = code =>
        sql"select game_id from game_join_codes where join_code = ${code.value}"
          .query[UUID]
          .option
          .map(_.map(GameId(_))),
      saveDisplayName = (gameId, participantId, name) =>
        sql"""insert into display_profiles (participant_id, game_id, display_name)
              values (${participantId.value}, ${gameId.value}, ${name.value})""".update.run.void,
      displayNames = gameId =>
        sql"select participant_id, display_name from display_profiles where game_id = ${gameId.value}"
          .query[(UUID, String)]
          .to[List]
          .map(_.map((id, name) => ParticipantId(id) -> name).toMap),
      issueSession = (digest, gameId, subject, expiresAt) =>
        val (kind, subjectId) = subject match
          case CredentialSubject.Facilitator(id) => (FacilitatorKind, id.value)
          case CredentialSubject.Participant(id) => (ParticipantKind, id.value)
        sql"""insert into browser_sessions (token_digest, game_id, subject_kind, subject_id, expires_at)
              values ($digest, ${gameId.value}, $kind, $subjectId, $expiresAt)""".update.run.void
      ,
      resolveSession = (digest, now) =>
        sql"""select game_id, subject_kind, subject_id from browser_sessions
              where token_digest = $digest and expires_at > $now"""
          .query[(UUID, String, UUID)]
          .option
          .map(_.flatMap { (gameId, kind, subjectId) =>
            if kind == FacilitatorKind then
              Some(GameId(gameId) -> CredentialSubject.Facilitator(GameId(gameId)))
            else if kind == ParticipantKind then
              Some(GameId(gameId) -> CredentialSubject.Participant(ParticipantId(subjectId)))
            else None
          }),
      findIdempotent = (scope, key) =>
        sql"""select scope, idempotency_key, request_digest, status, body from idempotency_records
              where scope = $scope and idempotency_key = $key"""
          .query[(String, String, String, Int, String)]
          .option
          .map(_.map((s, k, d, status, body) => IdempotentRecord(s, k, d, status, body))),
      storeIdempotent = record =>
        sql"""insert into idempotency_records (scope, idempotency_key, request_digest, status, body)
              values (${record.scope}, ${record.key}, ${record.requestDigest}, ${record.status}, ${record.body})""".update.run.void,
      issueRecovery = (digest, gameId, subject, expiresAt) =>
        val (kind, subjectId) = kindAndId(subject)
        sql"""insert into recovery_credentials (token_digest, game_id, subject_kind, subject_id, expires_at)
              values ($digest, ${gameId.value}, $kind, $subjectId, $expiresAt)""".update.run.void
      ,
      resolveRecovery = (digest, now) =>
        sql"""select game_id, subject_kind, subject_id from recovery_credentials
              where token_digest = $digest and expires_at > $now and revoked = false"""
          .query[(UUID, String, UUID)]
          .option
          .map(_.flatMap(subjectOf)),
      refreshRecovery = (digest, expiresAt) =>
        sql"update recovery_credentials set expires_at = $expiresAt where token_digest = $digest".update.run.void,
      revokeSubject = (gameId, subject) =>
        val (kind, subjectId) = kindAndId(subject)
        sql"""update recovery_credentials set revoked = true
              where game_id = ${gameId.value} and subject_kind = $kind and subject_id = $subjectId""".update.run *>
          sql"""delete from browser_sessions
                where game_id = ${gameId.value} and subject_kind = $kind and subject_id = $subjectId""".update.run.void
    )
