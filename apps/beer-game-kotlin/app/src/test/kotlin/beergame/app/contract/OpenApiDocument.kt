package beergame.app.contract

import com.networknt.schema.InputFormat
import com.networknt.schema.SchemaRegistry
import com.networknt.schema.SchemaRegistryConfig
import com.networknt.schema.dialect.Dialects
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Files
import java.nio.file.Path

/*
 * API の契約（contracts/openapi.yaml。OpenAPI 3.1）の読み取りと、応答・要求の適合の検査。ADR-008、test-strategy.md「API の契約テスト」。
 * 検証には、OpenAPI 3.1 の方言を持つ JSON Schema の検証器（com.networknt:json-schema-validator）を使う。
 * 経路・状態・ヘッダーの突合は、この検証器の仕事ではないので、ここに薄く書いた。
 * 検査は、違反の一覧を返す（空なら適合）。違反を返す形にしたのは、検査自体が違反を見つけられること（常に緑でないこと）を、
 * わざと壊した入力で確かめるため。
 */

/** 仕様の 1 操作（メソッドと経路の組）。[template] は `/games/{gameId}/state` のように `servers` の url を除いた経路。 */
internal class SpecOperation(
    val id: String,
    val method: String,
    val template: String,
    val node: JsonNode,
) {
    val key: String get() = "$method $template"

    private val pattern = Regex(template.replace(Regex("\\{[^/}]+}"), "[^/]+"))

    fun matches(
        requestMethod: String,
        path: String,
    ): Boolean = requestMethod == method && pattern.matches(path)
}

/** 実際に返った応答。[path] は `servers` の url を除いた経路、[headers] の名前は小文字。 */
internal class ObservedResponse(
    val method: String,
    val path: String,
    val status: Int,
    val headers: Map<String, List<String>>,
    val body: String,
) {
    val contentType: String? get() = headers["content-type"]?.firstOrNull()?.substringBefore(";")?.trim()
}

internal class OpenApiDocument private constructor(
    private val root: ObjectNode,
) {
    private val registry =
        SchemaRegistry.withDefaultDialect(Dialects.getOpenApi31()) {
            it.schemaRegistryConfig(SchemaRegistryConfig.builder().formatAssertionsEnabled(true).build())
        }
    private val mapper = JsonMapper.builder().build()
    private val strictRoot: ObjectNode = closedObjects(root)

    /** `servers[0].url`（`/api/v1`）。 */
    val basePath: String = root.at("/servers/0/url").asString()

    val operations: List<SpecOperation> =
        root.get("paths").properties().flatMap { (template, item) ->
            HTTP_METHODS.mapNotNull { method ->
                item
                    .get(
                        method,
                    )?.let { SpecOperation(it.get("operationId").asString(), method.uppercase(), template, it) }
            }
        }

    /** 仕様の `ErrorCode`（problem+json の `code` の列挙）。 */
    val errorCodes: Set<String> =
        root
            .at("/components/schemas/ErrorCode/enum")
            .values()
            .map { it.asString() }
            .toSet()

    fun operation(id: String): SpecOperation = operations.single { it.id == id }

    fun operationFor(
        method: String,
        path: String,
    ): SpecOperation? = operations.firstOrNull { it.matches(method, path) }

    /** `$ref` を、仕様の中で解決する（`#/components/...` だけ。外部の参照は使わない）。 */
    private fun deref(node: JsonNode): JsonNode =
        node.get("\$ref")?.let { root.at(it.asString().removePrefix("#")) } ?: node

    /** 操作の宣言する `parameters`（`$ref` を解決した形）。 */
    fun parameters(op: SpecOperation): List<JsonNode> =
        op.node
            .get("parameters")
            ?.values()
            ?.map(::deref)
            .orEmpty()

    fun declaresHeader(
        op: SpecOperation,
        name: String,
    ): Boolean =
        parameters(op).any {
            it.get("in").asString() == "header" &&
                it.get("name").asString().equals(name, true)
        }

    fun requiresHeader(
        op: SpecOperation,
        name: String,
    ): Boolean =
        parameters(op).any {
            it.get("in").asString() == "header" && it.get("name").asString().equals(name, true) &&
                it.get("required")?.asBoolean(false) == true
        }

    // ---- 要求の適合 ----

    /** 要求の本文を、操作の `requestBody` のスキーマで検証した違反。本文を持たない操作に本文を渡せば、違反。 */
    fun requestBodyViolations(
        op: SpecOperation,
        body: String,
    ): List<String> {
        val schema = op.node.at("/requestBody/content/application~1json/schema")
        return if (schema.isMissingNode) {
            listOf("${op.key}: 仕様に requestBody が無い")
        } else {
            validate(pointerOf(schema), body, strict = false)
        }
    }

    // ---- 応答の適合 ----

    fun responseViolations(response: ObservedResponse): List<String> {
        val op = operationFor(response.method, response.path)
        return if (op == null) unroutedViolations(response) else routedViolations(op, response)
    }

    /** 経路が仕様に無い応答（存在しない経路の 404、メソッドの違う 405）。形は problem+json で、`code` は `request.*`。 */
    private fun unroutedViolations(response: ObservedResponse): List<String> {
        val expectedCode = UNROUTED_CODES[response.status]
        val label = "${response.method} ${response.path}"
        return if (expectedCode == null) {
            listOf("$label: 仕様に無い経路で、404・405 以外の状態 ${response.status} が返った")
        } else {
            problemViolations(label, response) + codeViolations(label, response, expectedCode)
        }
    }

    private fun codeViolations(
        label: String,
        response: ObservedResponse,
        expected: String,
    ): List<String> {
        val actual = mapper.readTree(response.body).get("code")?.asString()
        return if (actual == expected) emptyList() else listOf("$label: code が $actual（期待 $expected）")
    }

    private fun problemViolations(
        label: String,
        response: ObservedResponse,
    ): List<String> =
        buildList {
            if (response.contentType !=
                PROBLEM_JSON
            ) {
                add("$label: Content-Type が ${response.contentType}（期待 $PROBLEM_JSON）")
            }
            if (response.headers[CORRELATION_HEADER].isNullOrEmpty()) add("$label: $CORRELATION_HEADER が無い")
            addAll(validate("#/components/schemas/Problem", response.body).map { "$label: $it" })
        }

    private fun routedViolations(
        op: SpecOperation,
        response: ObservedResponse,
    ): List<String> {
        val declared = op.node.get("responses")
        val spec = declared.get(response.status.toString())?.let(::deref)
        return if (spec == null) {
            listOf("${op.key}: 状態 ${response.status} が仕様に無い（宣言: ${declared.propertyNames().sorted()}）")
        } else {
            bodyViolations(op, response, spec) + headerViolations(op, response, spec)
        }
    }

    private fun bodyViolations(
        op: SpecOperation,
        response: ObservedResponse,
        spec: JsonNode,
    ): List<String> {
        val label = "${op.key} ${response.status}"
        val contents = spec.get("content")
        return when {
            contents == null -> {
                if (response.body.isEmpty()) emptyList() else listOf("$label: 仕様は本文なしだが、本文が返った")
            }

            contents.get(response.contentType.orEmpty()) == null -> {
                listOf("$label: Content-Type が ${response.contentType}（宣言: ${contents.propertyNames().sorted()}）")
            }

            else -> {
                validate(pointerOf(contents.get(response.contentType.orEmpty()).get("schema")), response.body)
                    .map { "$label: $it" }
            }
        }
    }

    private fun headerViolations(
        op: SpecOperation,
        response: ObservedResponse,
        spec: JsonNode,
    ): List<String> {
        val label = "${op.key} ${response.status}"
        val declared =
            spec
                .get("headers")
                ?.propertyNames()
                .orEmpty()
                .map { it.lowercase() }
                .toSet()
        val missing = (declared - CONDITIONAL_HEADERS).filter { response.headers[it].isNullOrEmpty() }
        // 仕様に無いのに発行しているヘッダー（資格の Cookie、Location）は、利用者が知らないまま増えるので違反にする。
        val undeclared = ISSUANCE_HEADERS.filter { it !in declared && !response.headers[it].isNullOrEmpty() }
        return missing.map { "$label: 宣言されたヘッダー $it が無い" } +
            undeclared.map { "$label: 仕様に無いヘッダー $it が返った" } +
            retryAfterViolations(label, response)
    }

    /** `Retry-After` は、`app.rate_limited`（429）と `app.retry_exhausted`（503）のときだけ付ける（仕様の description）。 */
    private fun retryAfterViolations(
        label: String,
        response: ObservedResponse,
    ): List<String> {
        val code =
            if (response.contentType ==
                PROBLEM_JSON
            ) {
                mapper.readTree(response.body).get("code")?.asString()
            } else {
                null
            }
        val present = !response.headers["retry-after"].isNullOrEmpty()
        val required = code in RETRY_AFTER_CODES
        return when {
            required && !present -> listOf("$label: $code に Retry-After が無い")
            !required && present -> listOf("$label: Retry-After は $RETRY_AFTER_CODES のときだけ付ける（code=$code）")
            else -> emptyList()
        }
    }

    /** `components/schemas` のスキーマに対する検証（応答と要求の共通）。`pointer` は `#/components/schemas/X`。 */
    private fun validate(
        pointer: String,
        body: String,
        strict: Boolean = true,
    ): List<String> {
        val instance = mapper.readTree(body)
        // 仕様の全体の写しに、ルートの `$ref` を足したものをスキーマにする（`$ref` は、写しの中のスキーマに解決される）。
        // [strict]（応答の検査）は、さらに `unevaluatedProperties: false` を足し、仕様に無い項目を実装が返したら検出する。
        // 要求の検査は、仕様のとおり（仕様が許す未知の項目は許す）にする。
        val wrapper =
            if (strict) {
                strictRoot.deepCopy().put("\$ref", pointer).put("unevaluatedProperties", false)
            } else {
                root.deepCopy().put("\$ref", pointer)
            }
        return registry.getSchema(wrapper).validate(instance).map { "${it.instanceLocation}: ${it.message}" }
    }

    /** スキーマの節（`{ $ref: "#/components/schemas/X" }`）の参照先。参照でないスキーマは、この契約テストの対象外。 */
    private fun pointerOf(schema: JsonNode): String =
        checkNotNull(schema.get("\$ref")?.asString()) { "スキーマが \$ref ではない: $schema" }

    companion object {
        private val HTTP_METHODS = listOf("get", "put", "post", "delete", "patch")
        private const val PROBLEM_JSON = "application/problem+json"
        private const val CORRELATION_HEADER = "x-correlation-id"
        private val UNROUTED_CODES = mapOf(404 to "request.not_found", 405 to "request.method_not_allowed")
        private val CONDITIONAL_HEADERS = setOf("retry-after")
        private val ISSUANCE_HEADERS = listOf("set-cookie", "location")
        private val RETRY_AFTER_CODES = setOf("app.rate_limited", "app.retry_exhausted")

        fun load(path: Path): OpenApiDocument {
            val registry = SchemaRegistry.withDefaultDialect(Dialects.getOpenApi31()) { }
            val node = Files.newInputStream(path).use { registry.getSchema(it, InputFormat.YAML).schemaNode }
            return OpenApiDocument(node as ObjectNode)
        }

        /**
         * 仕様の写しで、`properties` を持つスキーマ（allOf の部品と、allOf の土台になるスキーマを除く）に、
         * `unevaluatedProperties: false` を足す。入れ子のオブジェクト（versions、results の要素など）も、仕様に無い項目を許さない。
         * allOf の合成は、検証の入口（ルートの `$ref`）で閉じるので、ここでは閉じない。
         */
        private fun closedObjects(source: ObjectNode): ObjectNode {
            val copy = source.deepCopy()
            val schemas = copy.at("/components/schemas")
            val bases = allOfBases(schemas)
            schemas.properties().filter { it.key !in bases }.forEach { close(it.value, memberOfAllOf = false) }
            return copy
        }

        private fun allOfBases(schemas: JsonNode): Set<String> =
            schemas
                .values()
                .flatMap { it.get("allOf")?.values().orEmpty() }
                .mapNotNull { it.get("\$ref")?.asString()?.substringAfterLast('/') }
                .toSet()

        private fun close(
            node: JsonNode,
            memberOfAllOf: Boolean,
        ) {
            if (node is ObjectNode) {
                if (node.has("properties") && !memberOfAllOf) node.put("unevaluatedProperties", false)
                node.get("allOf")?.values()?.forEach { close(it, memberOfAllOf = true) }
                node.get("properties")?.values()?.forEach { close(it, memberOfAllOf = false) }
                listOf("items", "additionalProperties").forEach { key -> node.get(key)?.let { close(it, false) } }
            }
        }
    }
}
