package beergame.http

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import kotlinx.serialization.descriptors.elementNames
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject

class LogRecordSpec :
    FunSpec({
        test("[NF-O1] LogRecord は、許可した項目だけを持つ（許可リスト。項目を足すと、この試験が落ちて、人が確かめる）") {
            val names =
                LogRecord
                    .serializer()
                    .descriptor.elementNames
                    .toSet()

            names shouldBe
                setOf(
                    "timestamp",
                    "level",
                    "correlationId",
                    "operation",
                    "result",
                    "status",
                    "durationMillis",
                    "gameId",
                    "gameVersion",
                    "sessionVersion",
                    "message",
                    "errorType",
                    "stack",
                )
        }

        test("[NF-O1] LogRecord は、資格・表示名・参加コード・冪等キー・非公開の値に当たる名前の項目を持たない（拒否リスト）") {
            val names =
                LogRecord
                    .serializer()
                    .descriptor.elementNames
                    .map { it.lowercase() }
            val forbidden =
                listOf("credential", "cookie", "token", "secret", "displayname", "joincode", "idempotency", "quantity")

            forbidden.forEach { word -> names.none { it.contains(word) } shouldBe true }
        }

        test("[NF-O1] Given 1 件の記録 When JSON にする Then null の項目は出さず、1 行の JSON になる") {
            val record =
                LogRecord(
                    timestamp = "2026-11-16T09:00:00Z",
                    level = "INFO",
                    correlationId = "c",
                    operation = "createGame",
                    result = "ok",
                    status = 201,
                    durationMillis = 12,
                )

            val text = record.toJsonLine()

            text shouldBe
                """{"timestamp":"2026-11-16T09:00:00Z","level":"INFO","correlationId":"c","operation":"createGame",""" +
                """"result":"ok","status":201,"durationMillis":12}"""
            Json.parseToJsonElement(text).jsonObject.containsKey("gameId") shouldBe false
        }
    })
