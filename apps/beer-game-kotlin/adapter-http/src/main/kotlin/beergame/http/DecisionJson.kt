package beergame.http

import beergame.application.CoHolderView
import beergame.application.DecisionDetail
import beergame.application.DecisionEditorView
import beergame.application.EditorKind
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * 入力の保存者・保存の時刻・共同担当の JSON（B6。contracts/openapi.yaml の DecisionEditor・DecisionEntry・CoHolder）。
 * 表示名を返してよいかは application の開示の規則（Disclosure）が決めたもので、ここは書き出すだけ（値を足さない）。
 */

/** 保存者。進行役の代理入力は表示名を持たない（項目ごと含めない）。参加者で表示名が無いときは null。 */
internal fun editorJson(editor: DecisionEditorView): JsonObject =
    buildJsonObject {
        put("kind", editor.kind.name)
        put("isSelf", editor.isSelf)
        if (editor.kind == EditorKind.PARTICIPANT) {
            put("displayName", editor.displayName?.let(::JsonPrimitive) ?: JsonNull)
        }
    }

/** 保存済みの入力 1 件（競合の 409 の `latest`・`current` の項目）。 */
internal fun decisionDetailJson(detail: DecisionDetail): JsonObject =
    buildJsonObject {
        put("quantity", detail.quantity)
        put("version", detail.version)
        put("editor", editorJson(detail.editor))
        put("savedAt", detail.savedAt.toString())
    }

/** 同じ役割の共同担当。参加者の ID は含めない。 */
internal fun coHolderJson(coHolder: CoHolderView): JsonObject =
    buildJsonObject {
        put("displayName", coHolder.displayName?.let(::JsonPrimitive) ?: JsonNull)
        put("isSelf", coHolder.isSelf)
    }
