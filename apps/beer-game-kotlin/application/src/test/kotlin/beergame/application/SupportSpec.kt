package beergame.application

import beergame.domain.Actor
import beergame.domain.ActorKind
import beergame.domain.ActorRef
import beergame.domain.DisplayName
import beergame.domain.GameCommand
import beergame.domain.GameEvent
import beergame.domain.GameId
import beergame.domain.GameSettings
import beergame.domain.JoinCode
import beergame.domain.ParticipantId
import beergame.domain.RetentionDays
import beergame.domain.Role
import beergame.domain.StreamVersion
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import java.util.UUID

private val SECRET = ByteArray(32) { it.toByte() }
private val OTHER_SECRET = ByteArray(32) { (it + 1).toByte() }
private val GAME = GameId(UUID(1L, 1L))
private val PARTICIPANT = ParticipantId(UUID(2L, 2L))

private fun version(n: Long): StreamVersion = StreamVersion.of(n).ok()

class SupportSpec :
    FunSpec({
        test("[ADR-004] Given 資格の生の値 When ダイジェストを作る Then 決定的で、生の値を含まず、鍵が違えば別の値で、冪等キーのダイジェストとも衝突しない") {
            val digest = CredentialDigest.of(SECRET, "raw-credential")

            digest shouldBe CredentialDigest.of(SECRET, "raw-credential")
            digest shouldNotContain "raw-credential"
            digest.matches(Regex("[0-9a-f]{64}")) shouldBe true
            (digest == CredentialDigest.of(OTHER_SECRET, "raw-credential")) shouldBe false
            (digest == IdempotencyDigest.key(SECRET, "raw-credential")) shouldBe false
        }

        test("[ADR-004] Given 作成の応答（資格つき） When 保存用の本文へ符号化し、復元する Then 同じ応答に戻る") {
            val outcome =
                CommandOutcome(
                    GAME,
                    Versions(version(3), null),
                    IssuedCredential(
                        "abc-DEF_123",
                        CredentialKind.FACILITATOR,
                        ActorRef(ActorKind.FACILITATOR, GAME.value),
                    ),
                )

            OutcomeCodec.decode(OutcomeCodec.encode(outcome)).ok() shouldBe outcome
        }

        test("[ADR-004] Given 資格のない応答と、版が両方ある応答 When 符号化し、復元する Then 同じ応答に戻る") {
            listOf(
                CommandOutcome(GAME, Versions(null, version(12)), null),
                CommandOutcome(GAME, Versions(version(4), version(1)), null),
            ).forEach { OutcomeCodec.decode(OutcomeCodec.encode(it)).ok() shouldBe it }
        }

        test("[ADR-004] Given 壊れた保存済みの応答 When 復元する Then 例外にせず Persistence の失敗を返す") {
            listOf("", "v9\n", "v1\ngameId=not-a-uuid\ngame=1\nsession=-\ncredential=-\n").forEach {
                (OutcomeCodec.decode(it.toByteArray()).err() is AppFailure.Persistence) shouldBe true
            }
        }

        test("[#14] Given ゲーム作成のコマンド When 周辺ストアへの書き込みを導出する Then 進行役の資格の行だけで、表示名は無い") {
            val settings = GameSettings.kit(3, listOf(4, 4, 4)).ok()
            val command =
                GameCommand.CreateGame(
                    Actor.Anonymous,
                    T0,
                    GAME,
                    JoinCode.of("JOIN-0001").ok(),
                    settings,
                    RetentionDays.of(90).ok(),
                    T0.plusSeconds(100),
                )
            val issued =
                DigestedCredential(
                    "digest-1",
                    IssuedCredential("raw-1", CredentialKind.FACILITATOR, Actor.Facilitator(GAME).toRef()),
                )

            val writes = peripheralWrites(GAME, command, issued, 1, T0)

            writes shouldBe
                listOf(
                    PeripheralWrite.IssueCredentialRow(
                        GAME,
                        "digest-1",
                        CredentialKind.FACILITATOR,
                        GAME.value,
                        1,
                        T0,
                        T0.plusSeconds(100),
                    ),
                )
        }

        test("[#14] Given 参加のコマンド When 周辺ストアへの書き込みを導出する Then 表示名と復帰資格の行を、この順で返す") {
            val command =
                GameCommand.JoinGame(Actor.Anonymous, T0, PARTICIPANT, DisplayName.of("田中").ok(), T0.plusSeconds(200))
            val issued =
                DigestedCredential(
                    "digest-2",
                    IssuedCredential(
                        "raw-2",
                        CredentialKind.PARTICIPANT_RECOVERY,
                        Actor.Participant(PARTICIPANT).toRef(),
                    ),
                )

            val writes = peripheralWrites(GAME, command, issued, 1, T0)

            writes shouldBe
                listOf(
                    PeripheralWrite.SaveDisplayName(GAME, PARTICIPANT, DisplayName.of("田中").ok(), T0),
                    PeripheralWrite.IssueCredentialRow(
                        GAME,
                        "digest-2",
                        CredentialKind.PARTICIPANT_RECOVERY,
                        PARTICIPANT.value,
                        1,
                        T0,
                        T0.plusSeconds(200),
                    ),
                )
        }

        test("[#14] Given 資格を発行しないコマンド（割り当て） When 周辺ストアへの書き込みを導出する Then 何も書かない") {
            val assign = GameCommand.AssignRole(Actor.Facilitator(GAME), T0, PARTICIPANT, Role.RETAILER)

            peripheralWrites(GAME, assign, null, 1, T0) shouldBe emptyList()
        }

        test("[#14] Given 資格の生成 When 2 回作る Then 十分に長く、URL に安全な文字だけで、毎回違う") {
            val a = SecureTokens.newCredential()
            val b = SecureTokens.newCredential()

            a.length shouldBe 43
            a.matches(Regex("[A-Za-z0-9_-]+")) shouldBe true
            (a == b) shouldBe false
        }

        test("[AC1.1.1] Given 参加コードの生成 When 2 回作る Then 8 桁以上で、紛らわしい文字を含まず、毎回違う") {
            val a = SecureTokens.newJoinCode()
            val b = SecureTokens.newJoinCode()

            (a.length >= JoinCode.MIN_LENGTH) shouldBe true
            a.matches(Regex("[A-HJ-NP-Z2-9]+")) shouldBe true
            (a == b) shouldBe false
        }
    })
