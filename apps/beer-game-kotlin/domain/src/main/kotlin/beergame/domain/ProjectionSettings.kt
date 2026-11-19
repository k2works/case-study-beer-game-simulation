package beergame.domain

// 設定の投影の値（`game_overview.settings_changes`、`game_settings.initial_conditions`）。

/** キットの値から変えた項目の名前（JSON の配列）。 */
internal fun settingsChangesJson(settings: GameSettings): Value =
    Value.Json(settings.changedFields().joinToString(prefix = "[", postfix = "]", separator = ",") { "\"${it.name}\"" })

internal fun initialConditionsJson(initial: InitialConditions): Value =
    Value.Json(
        Role.entries.joinToString(
            prefix = "{\"inventory\":{",
            postfix = "},\"flow\":${initial.flow.value}}",
            separator = ",",
        ) {
            "\"${it.name}\":${initial.inventory[it].value}"
        },
    )
