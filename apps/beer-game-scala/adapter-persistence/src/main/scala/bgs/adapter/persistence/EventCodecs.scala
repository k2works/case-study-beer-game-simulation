package bgs.adapter.persistence

import bgs.domain.*
import io.circe.generic.semiauto.deriveCodec
import io.circe.{Codec, Decoder, Encoder}

import java.util.UUID

/** イベントの JSON 化。値オブジェクトは、復元時に検証する（不正な値は読み込めない）。 個人情報と秘密は入れない（表示名・資格の値はイベントに無い。NF-S14）。
  */
object EventCodecs:

  private def validated[A, B](decoder: Decoder[A])(f: A => Either[ValidationError, B]): Decoder[B] =
    decoder.emap(a => f(a).left.map(_.toString))

  private def enumCodec[A](all: Array[A], name: A => String): Codec[A] =
    Codec.from(
      Decoder[String].emap(s => all.find(name(_) == s).toRight(s"未知の値: $s")),
      Encoder[String].contramap(name)
    )

  given Codec[GameId] = Codec.from(Decoder[UUID].map(GameId(_)), Encoder[UUID].contramap(_.value))
  given Codec[ParticipantId] =
    Codec.from(Decoder[UUID].map(ParticipantId(_)), Encoder[UUID].contramap(_.value))
  given Codec[JoinCode] =
    Codec.from(validated(Decoder[String])(JoinCode.of), Encoder[String].contramap(_.value))
  given Codec[RetentionDays] =
    Codec.from(validated(Decoder[Int])(RetentionDays.of), Encoder[Int].contramap(_.value))
  given Codec[Week] = Codec.from(validated(Decoder[Int])(Week.of), Encoder[Int].contramap(_.value))
  given Codec[Quantity] =
    Codec.from(validated(Decoder[Int])(Quantity.of), Encoder[Int].contramap(_.value))
  given Codec[Units] =
    Codec.from(validated(Decoder[Long])(Units.of), Encoder[Long].contramap(_.value))
  given Codec[Money] =
    Codec.from(validated(Decoder[Long])(Money.of), Encoder[Long].contramap(_.minor))
  given Codec[DecisionVersion] =
    Codec.from(Decoder[Long].map(DecisionVersion.of), Encoder[Long].contramap(_.value))

  given Codec[Role] = enumCodec(Role.values, _.toString)
  given Codec[CommitMode] = enumCodec(CommitMode.values, _.toString)
  given Codec[CommitKind] = enumCodec(CommitKind.values, _.toString)
  given Codec[EndReason] = enumCodec(EndReason.values, _.toString)
  given Codec[DisclosurePolicy] = enumCodec(DisclosurePolicy.values, _.toString)

  given [A: Encoder: Decoder]: Codec[RoleMap[A]] = deriveCodec
  given Codec[Pipeline] = deriveCodec
  given Codec[RoleState] = deriveCodec
  given Codec[RoleWeekResult] = deriveCodec
  given Codec[DemandSeries] = deriveCodec
  given Codec[CostPolicy] = deriveCodec
  given Codec[Delay] = deriveCodec
  given Codec[Delays] = deriveCodec
  given Codec[InitialConditions] = deriveCodec
  given Codec[GameSettings] = deriveCodec
  given Codec[Editor] = deriveCodec
  given Codec[GameEvent] = deriveCodec
  given Codec[SessionEvent] = deriveCodec
