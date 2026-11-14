package beergame.persistence

/**
 * SQL の方言（PostgreSQL 18 と、ローカル開発専用の H2 の PostgreSQL モード）。
 * 共通の DDL を最大化し、差分だけをここと `db/migration/{postgres,h2}` に置く（data-model.md「方言の差分」）。
 */
enum class Dialect(
    /** マイグレーションのプレースホルダ `${json_type}`。 */
    val jsonType: String,
    /** JSON 文字列を JSON の列へ書く式。H2 は `FORMAT JSON` を付けないと JSON の文字列値になる（Step 1 の実測）。 */
    val jsonParam: String,
    /** Flyway の場所。共通 + 各方言。 */
    val migrationLocations: List<String>,
) {
    POSTGRES(
        jsonType = "jsonb",
        jsonParam = "CAST(? AS jsonb)",
        migrationLocations = listOf("classpath:db/migration/common", "classpath:db/migration/postgres"),
    ),
    H2(
        jsonType = "json",
        jsonParam = "? FORMAT JSON",
        migrationLocations = listOf("classpath:db/migration/common"),
    ),
}
