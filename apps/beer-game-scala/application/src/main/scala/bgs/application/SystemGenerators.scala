package bgs.application

import cats.effect.IO

import java.security.SecureRandom
import java.util.{Base64, UUID}

/** 実際の時計・乱数による [[Generators]]（ドメインは時計・乱数を持たず、ここから受け取る）。 */
object SystemGenerators:
  private val random = new SecureRandom()
  private val JoinCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  private val JoinCodeLength = 10

  /** 資格の値は 256 ビットの乱数（URL セーフな Base64）。URL・ログ・本文に含めない。 */
  private def randomToken: IO[String] = IO.delay {
    val bytes = new Array[Byte](32)
    random.nextBytes(bytes)
    Base64.getUrlEncoder.withoutPadding.encodeToString(bytes)
  }

  /** 参加コードは、推測しにくい乱数から作る 10 文字（紛らわしい文字を除く）。 */
  private def randomJoinCode: IO[String] = IO.delay {
    List
      .fill(JoinCodeLength)(JoinCodeAlphabet.charAt(random.nextInt(JoinCodeAlphabet.length)))
      .mkString
  }

  val system: bgs.application.Generators =
    bgs.application.Generators(
      now = IO.realTimeInstant,
      uuid = IO.delay(UUID.randomUUID()),
      token = randomToken,
      joinCode = randomJoinCode
    )
