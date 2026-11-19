package beergame.http

import arrow.core.nonEmptyListOf
import beergame.application.AppFailure
import beergame.application.PersistenceFailure
import beergame.domain.GameError
import beergame.domain.ParticipantId
import beergame.domain.Role
import beergame.domain.SessionError
import beergame.domain.ValidationError
import beergame.domain.Week
import io.kotest.assertions.fail
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID

private val CORRELATION = UUID(1L, 2L)

private fun domain(error: beergame.domain.DomainError): Problem = AppFailure.Domain(error).toProblem()

private fun week(n: Int): Week = Week.of(n).getOrNull() ?: fail("週 $n を作れない")

private fun JsonObject.str(name: String): String = getValue(name).jsonPrimitive.content

class ProblemMappingSpec :
    FunSpec({
        test("[US2.1/AC2.1.2] Given 権限の不足（業務の Forbidden）と資格の失敗 When 写す Then 403 で、本文（相関 ID を除く）が同じ") {
            val reasons =
                listOf(
                    AppFailure.Unauthorized.toProblem(),
                    domain(GameError.Forbidden("割り当ては進行役だけができる")),
                    domain(SessionError.Forbidden("確定は進行役だけができる")),
                )

            reasons.forEach { it.status shouldBe 403 }
            val bodies = reasons.map { it.toJson(CORRELATION).toString() }
            bodies.toSet().size shouldBe 1
            bodies.first() shouldBe
                """{"type":"/problems/app.unauthorized","title":"この操作を行う権限がありません。","status":403,""" +
                """"code":"app.unauthorized","correlationId":"$CORRELATION"}"""
            // 業務の理由（誰ができるか）を、利用者へ返さない
            bodies.forEach { it shouldNotContain "進行役" }
        }

        test("[US1.2/AC1.2.2] Given 無効な参加コード When 写す Then 403 の game.invitation_invalid（権限の不足とは別の code）") {
            val problem = domain(GameError.InvitationInvalid)

            problem.status shouldBe 403
            problem.code shouldBe "game.invitation_invalid"
            problem.toJson(CORRELATION).str("type") shouldBe "/problems/game.invitation_invalid"
        }

        test("[US1.2/AC1.2.2] Given 受付が終了したゲーム When 写す Then 409 の game.not_preparing（理由を示す）") {
            val problem = domain(GameError.NotPreparing)

            problem.status shouldBe 409
            problem.code shouldBe "game.not_preparing"
        }

        test("[US1.2/AC1.2.3] Given 開始の条件の不足 When 写す Then 422 で、不足する役割を上流から下流の順に示す") {
            val problem = domain(GameError.StartConditionNotMet(listOf(Role.FACTORY, Role.DISTRIBUTOR)))

            problem.status shouldBe 422
            problem.code shouldBe "game.start_condition_not_met"
            val missing = problem.toJson(CORRELATION).getValue("missingRoles").jsonArray
            missing shouldBe JsonArray(listOf(JsonPrimitive("FACTORY"), JsonPrimitive("DISTRIBUTOR")))
        }

        test("[US2.3] Given 入力が揃わない週の確定 When 写す Then 422 で、不足する役割を示す") {
            val problem = domain(SessionError.IncompleteDecisions(listOf(Role.RETAILER)))

            problem.status shouldBe 422
            problem.code shouldBe "session.incomplete_decisions"
            problem.toJson(CORRELATION).getValue("missingRoles") shouldBe JsonArray(listOf(JsonPrimitive("RETAILER")))
        }

        test("[US2.3/AC2.3.2] Given 週が進んだ後の確定 When 写す Then 409 の session.week_advanced で、要求した週と現在の週を示す") {
            val problem = domain(SessionError.WeekAdvanced(week(1), week(2)))

            problem.status shouldBe 409
            problem.code shouldBe "session.week_advanced"
            val body = problem.toJson(CORRELATION)
            body.getValue("requestedWeek").jsonPrimitive.int shouldBe 1
            body.getValue("currentWeek").jsonPrimitive.int shouldBe 2
        }

        test("[US2.2] Given 入力の版の競合 When 写す Then 409 の session.decision_conflict で、最新値と版を示す") {
            val problem = domain(SessionError.DecisionConflict(Role.RETAILER, null))

            problem.status shouldBe 409
            problem.code shouldBe "session.decision_conflict"
            problem.toJson(CORRELATION).str("role") shouldBe "RETAILER"
        }

        test("[US2.3] Given 確定の根拠が変わった When 写す Then 409 の session.decisions_changed で、現在の入力の版を示す") {
            val problem = domain(SessionError.DecisionsChanged(week(1), emptyMap()))

            problem.status shouldBe 409
            problem.code shouldBe "session.decisions_changed"
        }

        test("Given 状態の分類（InvalidState）のエラー When 写す Then 409 でそのまま code を返す") {
            listOf(
                GameError.AlreadyCreated to "game.already_created",
                SessionError.AlreadyStarted to "session.already_started",
                SessionError.NotActive to "session.not_active",
                SessionError.AlreadyEnded to "session.already_ended",
            ).forEach { (error, code) ->
                val problem = domain(error)
                problem.status shouldBe 409
                problem.code shouldBe code
            }
        }

        test("Given 存在しない参加者 When 写す Then 404（NotFound の分類）") {
            val problem = domain(GameError.ParticipantNotFound(ParticipantId(UUID(0, 5))))

            problem.status shouldBe 404
            problem.code shouldBe "game.participant_not_found"
        }

        test("[US2.2/AC2.2.2] Given 入力の誤り（複数） When 写す Then 422 で、項目ごとの誤りをすべて集めた配列を返す") {
            val problem =
                AppFailure
                    .Invalid(
                        nonEmptyListOf(
                            ValidationError.QuantityOutOfRange(1001, 1000),
                            ValidationError.DemandSeriesInvalid(5, "需要は 0〜1000 の整数"),
                            ValidationError.DisplayNameInvalid(0),
                        ),
                    ).toProblem()

            problem.status shouldBe 422
            problem.code shouldBe "validation.invalid_input"
            val errors =
                problem
                    .toJson(CORRELATION)
                    .getValue("errors")
                    .jsonArray
                    .map { it.jsonObject }
            errors.map { it.str("field") } shouldBe listOf("quantity", "demand", "displayName")
            errors[1].getValue("week").jsonPrimitive.int shouldBe 5
            errors[1].str("message") shouldBe "需要は 0〜1000 の整数"
            errors[0].containsKey("week") shouldBe false
        }

        test("[NF] Given 再試行の上限 When 写す Then 503 の app.retry_exhausted で、Retry-After を持ち、type も持つ") {
            val problem = AppFailure.RetryExhausted.toProblem()

            problem.status shouldBe 503
            problem.code shouldBe "app.retry_exhausted"
            (problem.retryAfterSeconds ?: fail("Retry-After が無い")) shouldBe 1
            problem.toJson(CORRELATION).str("type") shouldBe "/problems/app.retry_exhausted"
        }

        test("Given 競合（通常は再試行で吸収される） When 写す Then 利用者へ返す場合も、type を持つ 503（Retry-After つき）") {
            val problem = AppFailure.ConcurrencyConflict.toProblem()

            problem.status shouldBe 503
            problem.code shouldBe "app.retry_exhausted"
            problem.retryAfterSeconds shouldBe 1
        }

        test("Given 同じキーで内容が違う要求 When 写す Then 409 の app.idempotency_key_reused") {
            val problem = AppFailure.IdempotencyKeyReused.toProblem()

            problem.status shouldBe 409
            problem.code shouldBe "app.idempotency_key_reused"
        }

        test("[US6.1/AC6.1.2] Given 永続化の失敗 When 写す Then 500 の app.internal で、内部の情報（操作名・メッセージ）を返さない") {
            val problem =
                AppFailure
                    .Persistence(PersistenceFailure("events.append", "SQLSTATE 23505 uq_events_stream_version"))
                    .toProblem()

            problem.status shouldBe 500
            problem.code shouldBe "app.internal"
            val body = problem.toJson(CORRELATION).toString()
            body shouldNotContain "events.append"
            body shouldNotContain "SQLSTATE"
            body shouldNotContain "uq_events_stream_version"
        }

        test("Given どの失敗も When problem+json にする Then type は /problems/{code} で、code と相関 ID を持つ") {
            val failures =
                listOf(
                    AppFailure.Unauthorized,
                    AppFailure.RetryExhausted,
                    AppFailure.IdempotencyKeyReused,
                    AppFailure.ConcurrencyConflict,
                    AppFailure.Persistence(PersistenceFailure("x", "y")),
                    AppFailure.Domain(SessionError.NotActive),
                )

            failures.forEach { failure ->
                val problem = failure.toProblem()
                val body = problem.toJson(CORRELATION)
                body.str("type") shouldBe "/problems/${problem.code}"
                body.str("code") shouldBe problem.code
                body.str("correlationId") shouldBe CORRELATION.toString()
                body.getValue("status").jsonPrimitive.int shouldBe problem.status
            }
        }
    })
