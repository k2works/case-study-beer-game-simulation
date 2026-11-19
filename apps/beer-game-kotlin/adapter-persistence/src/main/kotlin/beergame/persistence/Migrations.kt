package beergame.persistence

import org.flywaydb.core.Flyway
import javax.sql.DataSource

object Migrations {
    private const val JSON_TYPE_PLACEHOLDER = "json_type"
    private const val LOCATIONS_KEY = "flyway.locations"

    /**
     * Flyway で、共通 + 方言の場所のマイグレーションを適用する。適用した件数を返す（再適用は 0）。
     * 共通の DDL は、方言で型が違う列をプレースホルダ（`${json_type}`）で切り替える。
     */
    fun migrate(
        dataSource: DataSource,
        dialect: Dialect,
    ): Int =
        Flyway
            .configure()
            .dataSource(dataSource)
            .configuration(mapOf(LOCATIONS_KEY to dialect.migrationLocations.joinToString(",")))
            .placeholders(mapOf(JSON_TYPE_PLACEHOLDER to dialect.jsonType))
            .load()
            .migrate()
            .migrationsExecuted
}
