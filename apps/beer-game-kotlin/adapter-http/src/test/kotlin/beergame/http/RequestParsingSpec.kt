package beergame.http

import arrow.core.Either
import beergame.application.CommitWeekInput
import beergame.application.CreateGameInput
import beergame.application.JoinGameInput
import beergame.domain.ConditionInputs
import beergame.domain.CredentialSubject
import beergame.domain.ParticipantId
import beergame.domain.Role
import beergame.domain.RoleMap
import io.kotest.assertions.fail
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID

private fun <A> Either<Problem, A>.ok(): A =
    when (this) {
        is Either.Right -> value
        is Either.Left -> fail("Left だった: ${value.code} ${value.toJson(UUID(0, 0))}")
    }

private fun <A> Either<Problem, A>.problem(): Problem =
    when (this) {
        is Either.Left -> value
        is Either.Right -> fail("Right だった: $value")
    }

private fun Problem.fields(): List<Pair<String, Int?>> =
    toJson(UUID(0, 0))
        .getValue("errors")
        .jsonArray
        .map { it.jsonObject }
        .map { it.getValue("field").jsonPrimitive.content to it["week"]?.jsonPrimitive?.int }

private fun bytes(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)

class RequestParsingSpec :
    FunSpec({
        test("[US1.1/AC1.1.1] Given キット準拠の有効な本文 When 解釈する Then 最終週・需要系列・保持日数を取り出す（保持日数の既定は 90）") {
            val input = parseCreateGame(bytes("""{"kind":"KIT","finalWeek":3,"demand":[4,4,8]}""")).ok()

            input shouldBe CreateGameInput(3, listOf(4, 4, 8), 90)
        }

        test("[US1.1/AC1.1.1] Given 保持日数を指定した本文 When 解釈する Then その値を渡す") {
            parseCreateGame(bytes("""{"kind":"KIT","finalWeek":1,"demand":[4],"retentionDays":30}""")).ok() shouldBe
                CreateGameInput(1, listOf(4), 30)
        }

        test("Given JSON として不正な本文 When 解釈する Then 400（構文エラー）") {
            listOf("", "{", "[1,2]", "null", "\"x\"", """{"kind":"KIT",}""").forEach { text ->
                val problem = parseCreateGame(bytes(text)).problem()
                problem.status shouldBe 400
                problem.code shouldBe "validation.invalid_input"
            }
        }

        test("Given UTF-8 として不正なバイト列 When 解釈する Then 400") {
            parseCreateGame(byteArrayOf(0x7B, 0xC3.toByte(), 0x28, 0x7D)).problem().status shouldBe 400
        }

        test("[US1.1/AC1.1.2] Given 必須の項目が無い・型が違う本文 When 解釈する Then 422 で、項目ごとの誤りをすべて集める") {
            val problem = parseCreateGame(bytes("""{"kind":"OTHER","finalWeek":"12"}""")).problem()

            problem.status shouldBe 422
            problem.fields().map { it.first } shouldBe listOf("kind", "finalWeek", "demand")
        }

        test("[B7/AC1.1.3] Given kind が CUSTOM で conditions がある本文 When 解釈する Then 条件を取り出す（指定の無い項目は null）") {
            val body =
                """{"kind":"CUSTOM","finalWeek":2,"demand":[4,4],"conditions":""" +
                    """{"initialInventory":{"RETAILER":20},"shipmentDelayWeeks":3,""" +
                    """"holdingCostMinor":80,"disclosurePolicy":"NONE"}}"""

            parseCreateGame(bytes(body)).ok() shouldBe
                CreateGameInput(
                    2,
                    listOf(4, 4),
                    90,
                    ConditionInputs(
                        initialInventory = mapOf(Role.RETAILER to 20),
                        shipmentDelayWeeks = 3,
                        holdingCostMinor = 80,
                        disclosurePolicy = "NONE",
                    ),
                )
        }

        test("[B7/AC1.1.3] Given kind が CUSTOM で conditions が無い本文 When 解釈する Then 空の条件（キットの値のまま）") {
            parseCreateGame(bytes("""{"kind":"CUSTOM","finalWeek":1,"demand":[4]}""")).ok().conditions shouldBe
                ConditionInputs()
        }

        test("[B7/AC1.1.3] Given kind が KIT で conditions がある本文 When 解釈する Then 422 で conditions を示す") {
            val problem =
                parseCreateGame(
                    bytes("""{"kind":"KIT","finalWeek":1,"demand":[4],"conditions":{"orderDelayWeeks":3}}"""),
                ).problem()

            problem.status shouldBe 422
            problem.fields() shouldBe listOf("conditions" to null)
        }

        test("[B7/AC1.1.4] Given 条件の型が違う・未知の役割 When 解釈する Then 項目ごとに conditions.<名前> の誤りをすべて集める") {
            val body =
                """{"kind":"CUSTOM","finalWeek":1,"demand":[4],"conditions":""" +
                    """{"initialInventory":{"CLERK":1},"orderDelayWeeks":"3",""" +
                    """"holdingCostMinor":1.5,"disclosurePolicy":7}}"""

            parseCreateGame(bytes(body)).problem().fields().map { it.first } shouldBe
                listOf(
                    "conditions.initialInventory",
                    "conditions.orderDelayWeeks",
                    "conditions.holdingCostMinor",
                    "conditions.disclosurePolicy",
                )
        }

        test("[US1.1/AC1.1.2] Given 需要系列に小数・文字・null が混ざる When 解釈する Then 対象の週（1 始まり）を示す") {
            val problem = parseCreateGame(bytes("""{"kind":"KIT","finalWeek":4,"demand":[4,1.5,"x",null]}""")).problem()

            problem.status shouldBe 422
            problem.fields() shouldBe listOf("demand" to 2, "demand" to 3, "demand" to 4)
        }

        test("[US1.1/AC1.1.2] Given 需要系列が配列でない When 解釈する Then demand の誤り（週なし）") {
            val problem = parseCreateGame(bytes("""{"kind":"KIT","finalWeek":4,"demand":"4,4,4,4"}""")).problem()

            problem.fields() shouldBe listOf("demand" to null)
        }

        test("[US1.1/AC1.1.2] Given 範囲外の整数（1001）の需要 When 解釈する Then 形は正しいので、検証は application に任せる") {
            parseCreateGame(bytes("""{"kind":"KIT","finalWeek":2,"demand":[4,1001]}""")).ok() shouldBe
                CreateGameInput(2, listOf(4, 1001), 90)
        }

        test("[US1.2/AC1.2.1] Given 参加コードと表示名 When 解釈する Then そのまま渡す（検証は application）") {
            parseJoinGame(bytes("""{"joinCode":"ABCDEFGH2345","displayName":"田中"}""")).ok() shouldBe
                JoinGameInput("ABCDEFGH2345", "田中")
        }

        test("[US1.2] Given 表示名が文字列でない When 解釈する Then 422 で displayName を示す") {
            parseJoinGame(bytes("""{"joinCode":"ABCDEFGH2345","displayName":12}""")).problem().fields() shouldBe
                listOf("displayName" to null)
        }

        test("[US1.2/AC1.2.5] Given 役割 When 解釈する Then 4 つの値だけを受け付ける") {
            Role.entries.forEach { role ->
                parseAssignRole(bytes("""{"role":"${role.name}"}""")).ok() shouldBe role
            }
            parseAssignRole(bytes("""{"role":"MANAGER"}""")).problem().fields() shouldBe listOf("role" to null)
            parseAssignRole(bytes("""{}""")).problem().fields() shouldBe listOf("role" to null)
        }

        test("[US2.2/AC2.2.1] Given 週と数量と If-Match When 解釈する Then 入力の版は If-Match から取る（無ければ 0）") {
            parseSaveDecision(bytes("""{"week":1,"quantity":8}"""), "3").ok() shouldBe
                DecisionBody(week = 1, quantity = 8, expectedVersion = 3)
            parseSaveDecision(bytes("""{"week":1,"quantity":8}"""), null).ok().expectedVersion shouldBe 0
            parseSaveDecision(bytes("""{"week":1,"quantity":8}"""), "\"5\"").ok().expectedVersion shouldBe 5
        }

        test("[US2.2/AC2.2.2] Given 小数・空・null・文字の数量 When 解釈する Then 422 で quantity を示す") {
            listOf("1.5", "\"\"", "null", "\"abc\"", "\" \"", "true").forEach { quantity ->
                val problem = parseSaveDecision(bytes("""{"week":1,"quantity":$quantity}"""), null).problem()
                problem.status shouldBe 422
                problem.fields() shouldBe listOf("quantity" to null)
            }
        }

        test("[US2.2/AC2.2.2] Given 項目が無い本文 When 解釈する Then 欠けている項目をすべて示す") {
            parseSaveDecision(bytes("""{}"""), null).problem().fields() shouldBe
                listOf("week" to null, "quantity" to null)
        }

        test("[US2.2/AC2.2.2] Given 範囲外の整数（負数・1001）の数量 When 解釈する Then 形は正しいので、検証は application に任せる") {
            parseSaveDecision(bytes("""{"week":1,"quantity":-1}"""), null).ok().quantity shouldBe -1
            parseSaveDecision(bytes("""{"week":1,"quantity":1001}"""), null).ok().quantity shouldBe 1001
        }

        test("[US2.2] Given Int を超える数量 When 解釈する Then 422 で quantity を示す（桁あふれで通さない）") {
            parseSaveDecision(bytes("""{"week":1,"quantity":99999999999}"""), null).problem().fields() shouldBe
                listOf("quantity" to null)
        }

        test("[US2.2] Given 数値でない If-Match When 解釈する Then 422 で If-Match を示す") {
            parseSaveDecision(bytes("""{"week":1,"quantity":8}"""), "abc").problem().fields() shouldBe
                listOf("If-Match" to null)
        }

        test("[US2.3/AC2.3.1] Given 確定の本文（requestedWeek と basis） When 解釈する Then 役割ごとの版を取り出す") {
            val text =
                """{"requestedWeek":1,"basis":{"FACTORY":1,"DISTRIBUTOR":2,"WHOLESALER":3,"RETAILER":4}}"""

            parseCommitWeek(bytes(text)).ok() shouldBe
                CommitWeekInput(1, RoleMap(factory = 1L, distributor = 2L, wholesaler = 3L, retailer = 4L))
        }

        test("[US2.3] Given basis に役割が欠ける・整数でない When 解釈する Then 422 で、欠けた役割を示す") {
            val problem =
                parseCommitWeek(bytes("""{"requestedWeek":1,"basis":{"FACTORY":1,"DISTRIBUTOR":"x"}}""")).problem()

            problem.fields() shouldBe
                listOf("basis.DISTRIBUTOR" to null, "basis.WHOLESALER" to null, "basis.RETAILER" to null)
        }

        test("[US2.3] Given basis が無い When 解釈する Then 422 で basis を示す") {
            parseCommitWeek(bytes("""{"requestedWeek":1}""")).problem().fields() shouldBe listOf("basis" to null)
        }

        test("Given 想定外の項目を含む本文 When 解釈する Then 無視する（既知の項目だけを使う）") {
            parseAssignRole(bytes("""{"role":"RETAILER","extra":1}""")).ok() shouldBe Role.RETAILER
        }

        test("[AC3.1.2] Given 代理入力の本文 When 解釈する Then requestedWeek と数量を取り出す。欠けた項目はすべて示す") {
            parseProxyDecision(bytes("""{"requestedWeek":2,"quantity":6}""")).ok() shouldBe ProxyBody(2, 6)
            parseProxyDecision(bytes("{}")).problem().fields() shouldBe
                listOf("requestedWeek" to null, "quantity" to null)
            parseProxyDecision(bytes("""{"requestedWeek":"2","quantity":6.5}""")).problem().fields() shouldBe
                listOf("requestedWeek" to null, "quantity" to null)
        }

        test("[AC3.1.2] Given 経路の役割 When 解釈する Then 4 つの値だけを受け付け、それ以外は role の誤り（422）") {
            Role.entries.forEach { roleParam(it.name).ok() shouldBe it }
            listOf(null, "", "MANAGER", "factory").forEach {
                val problem = roleParam(it).problem()
                problem.status shouldBe 422
                problem.fields() shouldBe listOf("role" to null)
            }
        }

        test("[AC3.2.5] Given 失効・再発行の対象 When 解釈する Then 参加者の ID だけを受け付ける") {
            val id = UUID.fromString("00000000-0000-0000-0000-0000000000a1")

            parseCredentialSubject(bytes("""{"subject":{"kind":"PARTICIPANT","id":"$id"}}""")).ok() shouldBe
                CredentialSubject.Participant(ParticipantId(id))
        }

        test("[AC3.2.5] Given 形の違う対象 When 解釈する Then 422 で、入れ子の項目名（subject.kind・subject.id）を示す") {
            val id = "00000000-0000-0000-0000-0000000000a1"

            parseCredentialSubject(bytes("{}")).problem().fields() shouldBe listOf("subject" to null)
            parseCredentialSubject(bytes("""{"subject":"x"}""")).problem().fields() shouldBe listOf("subject" to null)
            parseCredentialSubject(
                bytes("""{"subject":{"kind":"FACILITATOR","id":"$id"}}"""),
            ).problem().fields() shouldBe
                listOf("subject.kind" to null)
            parseCredentialSubject(
                bytes("""{"subject":{"kind":"PARTICIPANT","id":"not-a-uuid"}}"""),
            ).problem().fields() shouldBe
                listOf("subject.id" to null)
            parseCredentialSubject(bytes("""{"subject":{}}""")).problem().fields() shouldBe
                listOf("subject.kind" to null, "subject.id" to null)
        }

        test("[AC3.2.1] Given 復帰の本文 When 解釈する Then gameId と、省略できる復帰コードを取り出す") {
            val id = UUID.fromString("00000000-0000-0000-0000-0000000000a1")

            parseRecover(bytes("""{"gameId":"$id"}""")).ok() shouldBe RecoverBody(id, null)
            parseRecover(bytes("""{"gameId":"$id","recoveryCode":null}""")).ok() shouldBe RecoverBody(id, null)
            parseRecover(bytes("""{"gameId":"$id","recoveryCode":"v1.abc"}""")).ok() shouldBe RecoverBody(id, "v1.abc")
        }

        test("[AC3.2.1] Given 形の違う復帰の本文 When 解釈する Then 422 で、誤りのある項目をすべて示す") {
            parseRecover(bytes("{}")).problem().fields() shouldBe listOf("gameId" to null)
            parseRecover(bytes("""{"gameId":"x","recoveryCode":5}""")).problem().fields() shouldBe
                listOf("gameId" to null, "recoveryCode" to null)
        }
    })
