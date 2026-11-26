package bgs.domain

import java.util.UUID

/** ゲームの識別子。セッションの識別子も同じ値（1 ゲーム 1 セッション）。 */
final case class GameId(value: UUID)

final case class ParticipantId(value: UUID)

/** 表示名。前後の空白を除いて 1〜80 文字（コードポイント数）。イベントには入れない（NF-S14）。 */
opaque type DisplayName = String

object DisplayName:
  val MaxLength: Int = 80

  def of(raw: String): Either[ValidationError, DisplayName] =
    val trimmed = raw.trim
    val length = trimmed.codePointCount(0, trimmed.length)
    if length >= 1 && length <= MaxLength then Right(trimmed)
    else Left(ValidationError.DisplayNameInvalid(length))

  extension (n: DisplayName) def value: String = n

/** 参加コード。8 文字以上（生成は境界が行い、ドメインは受け取った値の長さだけを検証する）。 */
opaque type JoinCode = String

object JoinCode:
  val MinLength: Int = 8

  def of(raw: String): Either[ValidationError, JoinCode] =
    if raw.length >= MinLength then Right(raw)
    else Left(ValidationError.JoinCodeInvalid(raw.length))

  extension (c: JoinCode) def value: String = c

/** 保持日数。1〜3650。 */
opaque type RetentionDays = Int

object RetentionDays:
  val Min: Int = 1
  val Max: Int = 3650

  def of(n: Int): Either[ValidationError, RetentionDays] =
    if n >= Min && n <= Max then Right(n) else Left(ValidationError.RetentionOutOfRange(n))

  extension (d: RetentionDays) def value: Int = d

/** ストリームの版。追記したイベントの通し番号（楽観的並行制御の期待値）。 */
opaque type StreamVersion = Long

object StreamVersion:
  val Zero: StreamVersion = 0L

  /** 永続化から読んだ値、または境界で検証済みの値から作る。負数は 0 に丸める（版は 0 以上）。 */
  def of(n: Long): StreamVersion = math.max(0L, n)

  extension (v: StreamVersion)
    def value: Long = v
    def next: StreamVersion = v + 1L
