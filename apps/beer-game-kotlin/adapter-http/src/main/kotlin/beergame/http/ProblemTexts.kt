package beergame.http

import beergame.domain.ValidationError

/** 入力の誤りを、項目と修正内容にする。文言は、画面の辞書が持つ文言と別（API の `message` は修正内容の要点）。 */
internal fun ValidationError.toFieldError(): FieldError =
    when (this) {
        is ValidationError.QuantityOutOfRange -> FieldError("quantity", "数量は 0 以上 $max 以下の整数にしてください。")
        is ValidationError.WeekOutOfRange -> FieldError("week", "週は 1 以上 $max 以下の整数にしてください。")
        is ValidationError.UnitsNegative -> FieldError("units", "数量は 0 以上の整数にしてください。")
        is ValidationError.MoneyNegative -> FieldError("money", "金額は 0 以上にしてください。")
        is ValidationError.VersionNegative -> FieldError("version", "版は 0 以上の整数にしてください。")
        is ValidationError.DisplayNameInvalid -> FieldError("displayName", "表示名は 1 文字以上 80 文字以下にしてください。")
        is ValidationError.JoinCodeInvalid -> FieldError("joinCode", "参加コードの形式が正しくありません。")
        is ValidationError.RetentionOutOfRange -> FieldError("retentionDays", "保持日数は 1 以上 3650 以下の整数にしてください。")
        is ValidationError.DemandSeriesInvalid -> FieldError("demand", reason, weekIndex)
    }

private val TITLES =
    mapOf(
        "game.invitation_invalid" to "参加コードが無効です。",
        "game.not_preparing" to "このゲームは、参加の受付を終了しています。",
        "game.already_created" to "このゲームは、すでに作成されています。",
        "game.participant_not_found" to "参加者が見つかりません。",
        "game.start_condition_not_met" to "4 つの役割に参加者がそろっていないため、開始できません。",
        "session.not_active" to "進行中ではありません。",
        "session.already_ended" to "すでに終了しています。",
        "session.already_started" to "すでに開始しています。",
        "session.week_advanced" to "週はすでに進んでいます。",
        "session.decision_conflict" to "入力が、別の操作で更新されました。",
        "session.decisions_changed" to "確定の根拠にした入力が、変わりました。",
        "session.incomplete_decisions" to "入力がそろっていないため、確定できません。",
    )

private val DETAILS =
    mapOf(
        "game.not_preparing" to "ゲームは準備中ではありません（開始済みです）。",
        "game.already_created" to "同じゲームを二重に作成することはできません。",
        "session.not_active" to "セッションは進行中ではありません。",
        "session.already_ended" to "セッションは終了しています。",
        "session.already_started" to "セッションは開始済みです。",
    )

internal fun titleOf(code: String): String = TITLES[code] ?: "リクエストを処理できません。"

internal fun detailOf(code: String): String? = DETAILS[code]
