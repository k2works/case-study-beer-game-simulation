package beergame.persistence

import beergame.domain.Role
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainAll
import io.kotest.matchers.collections.shouldContainExactlyInAnyOrder
import io.kotest.matchers.ints.shouldBeGreaterThan
import io.kotest.matchers.shouldBe
import java.sql.Connection
import java.sql.ResultSet
import java.sql.SQLException
import java.util.UUID

private const val DATABASE = "beergame_roles"
private const val INSUFFICIENT_PRIVILEGE = "42501"

private const val WRITER = "beergame_writer"
private const val READER = "beergame_reader"
private const val OBSERVER = "beergame_observer"
private const val DELETER = "beergame_deleter"
private val APP_ROLES = listOf(WRITER, READER, OBSERVER, DELETER)

/** 観察者のロールが読める表（設計書 data-model.md の読み取りの規則。NF-S18）。 */
private val OBSERVER_READABLE = listOf("game_overview", "session_overview", "week_team_totals")

/** 所有者（スーパーユーザー）の接続を `SET ROLE` で用途別のロールに切り替えて実行する。ロールの権限だけが効く。 */
private fun <T> asRole(
    role: String,
    block: (Connection) -> T,
): T =
    PostgresSupport.connectionTo(DATABASE).use { c ->
        c.createStatement().use { it.execute("SET ROLE $role") }
        block(c)
    }

private fun <T> asOwner(block: (Connection) -> T): T = PostgresSupport.connectionTo(DATABASE).use(block)

private fun Connection.exec(sql: String): Int = createStatement().use { it.executeUpdate(sql) }

private fun <T> Connection.queryList(
    sql: String,
    map: (ResultSet) -> T,
): List<T> =
    createStatement().use { st ->
        st.executeQuery(sql).use { rs -> generateSequence { if (rs.next()) map(rs) else null }.toList() }
    }

private fun denied(
    role: String,
    sql: String,
) {
    val failure = shouldThrow<SQLException> { asRole(role) { it.exec(sql) } }
    failure.sqlState shouldBe INSUFFICIENT_PRIVILEGE
}

private fun deniedQuery(
    role: String,
    table: String,
) {
    val failure =
        shouldThrow<SQLException> { asRole(role) { it.queryList("SELECT * FROM $table") { rs -> rs.metaData } } }
    failure.sqlState shouldBe INSUFFICIENT_PRIVILEGE
}

private fun hasPrivilege(
    role: String,
    table: String,
    privilege: String,
): Boolean =
    asOwner { c ->
        c.queryList("SELECT has_table_privilege('$role', 'public.$table', '$privilege')") { it.getBoolean(1) }.single()
    }

private fun publicTables(): List<String> =
    asOwner { c ->
        c.queryList(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
        ) { it.getString(1) }
    }

/** `game_id` 列を持つ表を、`information_schema` から取得する（網羅の検査。表を足しても一覧を直さない）。 */
private fun gameIdTables(): List<String> =
    asOwner { c ->
        c.queryList(
            "SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t " +
                "ON t.table_schema = c.table_schema AND t.table_name = c.table_name " +
                "WHERE c.table_schema = 'public' AND c.column_name = 'game_id' AND t.table_type = 'BASE TABLE' " +
                "ORDER BY c.table_name",
        ) { it.getString(1) }
    }

/** 台本が書かない表（周辺ストアと観察者のロビー）に、行を足す。 */
private fun seedPeripheralRows(gameId: UUID) {
    asOwner { c ->
        c.exec(
            "INSERT INTO display_profiles VALUES ('$gameId', 'PARTICIPANT', '${UUID.randomUUID()}', 'a', now()) ON CONFLICT DO NOTHING",
        )
        c.exec(
            "INSERT INTO credentials VALUES ('d-${UUID.randomUUID()}', '$gameId', 'PARTICIPANT_RECOVERY', '${UUID.randomUUID()}', 1, now(), now(), NULL)",
        )
        c.exec(
            "INSERT INTO browser_sessions VALUES ('s-${UUID.randomUUID()}', '$gameId', 'PARTICIPANT', '${UUID.randomUUID()}', 1, now())",
        )
        c.exec(
            "INSERT INTO idempotency_records VALUES ('$gameId', 'x', 'k', 'r', 200, '\\x00', now()) ON CONFLICT DO NOTHING",
        )
        // week_team_totals は B1 では書かない（B9 で書く）。確定した週（1）の行に付ける。
        c.exec("INSERT INTO week_team_totals VALUES ('$gameId', 1, 1, 1, 1, 4) ON CONFLICT DO NOTHING")
        val invitation = UUID.randomUUID()
        c.exec("INSERT INTO lobby_observer_invitations VALUES ('$invitation', '$gameId', now(), NULL, now())")
        c.exec("INSERT INTO lobby_observers VALUES ('${UUID.randomUUID()}', '$gameId', '$invitation', now())")
    }
}

/**
 * DB ロールと GRANT（V102。PostgreSQL 専用。B5 Step 5.5 で 101 から付け替えた）の否定テスト（H12・H13 の一部）。H2 版にはロールが無いので、ここが正。
 * 各ロールの接続は、所有者の接続を `SET ROLE` で切り替えて作る（パスワードと用途別のプールは B3 以降）。
 */
class RolePrivilegesSpec :
    FunSpec({
        lateinit var fx: Fixture
        beforeSpec {
            PostgresSupport.recreateDatabase(DATABASE)
            fx =
                openFixture(
                    Dialect.POSTGRES,
                    PostgresSupport.dataSourceFor(DATABASE),
                    { PostgresSupport.connectionTo(DATABASE) },
                )
        }
        afterSpec { fx.close() }

        test("[3.1] Given 空の PostgreSQL When マイグレーションを適用する Then 用途別の 4 つのロールができる") {
            val roles =
                asOwner { c ->
                    c.queryList("SELECT rolname FROM pg_roles WHERE rolname LIKE 'beergame\\_%'") { it.getString(1) }
                }
            roles shouldContainAll APP_ROLES
        }

        test("[3.1] Given 書き込みロール When events を UPDATE・DELETE・TRUNCATE する Then 権限不足で拒否される（追記専用）") {
            denied(WRITER, "UPDATE events SET event_type = event_type")
            denied(WRITER, "DELETE FROM events")
            denied(WRITER, "TRUNCATE events")
        }

        test("[3.1] Given 書き込みロール When game_roots を DELETE・UPDATE・TRUNCATE する Then 拒否される（連鎖削除で events を消せない）") {
            denied(WRITER, "DELETE FROM game_roots")
            denied(WRITER, "UPDATE game_roots SET created_at = created_at")
            denied(WRITER, "TRUNCATE game_roots")
            denied(WRITER, "TRUNCATE game_roots CASCADE")
        }

        test("[3.1] Given 書き込みロール When ゲームのイベントを INSERT して SELECT する Then できる（過剰に絞っていない）") {
            val id = UUID.randomUUID()
            asRole(WRITER) { c ->
                c.exec("INSERT INTO game_roots (game_id, created_at) VALUES ('$id', now())")
                c.exec(
                    "INSERT INTO events (event_id, game_id, stream_type, stream_version, event_type, schema_version, " +
                        "payload, actor_kind, correlation_id, command_id, occurred_at) VALUES " +
                        "('${UUID.randomUUID()}', '$id', 'GAME', 1, 'GameCreated', 1, '{}', 'SYSTEM', " +
                        "'${UUID.randomUUID()}', '${UUID.randomUUID()}', now())",
                )
                c.queryList("SELECT count(*) FROM events WHERE game_id = '$id'") { it.getInt(1) }.single() shouldBe 1
                c.exec("UPDATE game_overview SET status = status")
                c.exec("DELETE FROM game_overview WHERE game_id = '$id'")
            }
        }

        test(
            "[B5/4.3] Given 書き込みロール When 資格の失効（credentials の UPDATE、browser_sessions の DELETE）を実行する Then できる。ほかのロールは資格の行を変更できない",
        ) {
            val id = UUID.randomUUID()
            val subject = UUID.randomUUID()
            asRole(WRITER) { c ->
                c.exec("INSERT INTO game_roots (game_id, created_at) VALUES ('$id', now())")
                c.exec(
                    "INSERT INTO credentials VALUES ('recovery-$id', '$id', 'PARTICIPANT_RECOVERY', '$subject', 1, now(), now() + interval '1 day', NULL)",
                )
                c.exec(
                    "INSERT INTO browser_sessions VALUES ('session-$id', '$id', 'PARTICIPANT', '$subject', 1, now() + interval '1 day')",
                )
                c.exec(
                    "UPDATE credentials SET revoked_at = now() WHERE game_id = '$id' " +
                        "AND kind = 'PARTICIPANT_RECOVERY' AND subject_id = '$subject' AND revoked_at IS NULL",
                ) shouldBe 1
                c.exec(
                    "DELETE FROM browser_sessions WHERE game_id = '$id' AND actor_kind = 'PARTICIPANT' AND actor_id = '$subject'",
                ) shouldBe 1
            }

            listOf(READER, OBSERVER, DELETER).forEach { role ->
                denied(role, "UPDATE credentials SET revoked_at = now() WHERE game_id = '$id'")
                denied(role, "DELETE FROM browser_sessions WHERE game_id = '$id'")
            }
            val countSql = "SELECT count(*) FROM credentials WHERE game_id = '$id' AND revoked_at IS NOT NULL"
            val revokedRows = asOwner { c -> c.queryList(countSql) { it.getInt(1) }.single() }
            revokedRows shouldBe 1
        }

        test(
            "[5.5] Given 参加・復帰の窓（participation_attempts）When ロールごとに操作する Then 書き込みロールだけが読み書き・掃除できる。ほかのロールは読めず、書けない（GRANT は 102 に含む）",
        ) {
            val key = "role-test-${UUID.randomUUID()}"
            asRole(WRITER) { c ->
                c.exec("INSERT INTO participation_attempts VALUES ('join', '$key', now(), 0) ON CONFLICT DO NOTHING")
                c.exec(
                    "UPDATE participation_attempts SET failure_count = failure_count + 1 WHERE key_digest = '$key'",
                ) shouldBe
                    1
                c.queryList(
                    "SELECT failure_count FROM participation_attempts WHERE key_digest = '$key'",
                ) { it.getInt(1) } shouldBe
                    listOf(1)
                c.exec("DELETE FROM participation_attempts WHERE key_digest = '$key'") shouldBe 1
            }

            listOf(READER, OBSERVER, DELETER).forEach { role ->
                deniedQuery(role, "participation_attempts")
                denied(role, "INSERT INTO participation_attempts VALUES ('join', 'x', now(), 0)")
                denied(role, "UPDATE participation_attempts SET failure_count = 0")
                denied(role, "DELETE FROM participation_attempts")
            }
            denied(WRITER, "TRUNCATE participation_attempts")
            // 窓の表はゲームに属さない（接続元の要約だけ）。ゲームの連鎖削除の対象にも、game_id を持つ表の網羅にも入らない
            gameIdTables().contains("participation_attempts") shouldBe false
        }

        test("[3.1] Given 4 つのロール When 表の所有者と所有者ロールのメンバーかを調べる Then いずれでもなく、特権も持たない") {
            asOwner { c ->
                val tables =
                    c.queryList("SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public'") {
                        it.getString(1) to
                            it.getString(2)
                    }
                tables.size shouldBeGreaterThan 10
                for (role in APP_ROLES) {
                    val ownedOrMember =
                        tables.filter { (_, tableOwner) ->
                            tableOwner == role ||
                                c
                                    .queryList(
                                        "SELECT pg_has_role('$role', '$tableOwner', 'MEMBER')",
                                    ) { it.getBoolean(1) }
                                    .single()
                        }
                    ownedOrMember.shouldBeEmpty()
                    c
                        .queryList(
                            "SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication " +
                                "FROM pg_roles WHERE rolname = '$role'",
                        ) { it.getBoolean(1) }
                        .single() shouldBe false
                    c
                        .queryList(
                            "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = '$role'",
                        ) { it.getInt(1) }
                        .single() shouldBe 0
                }
            }
        }

        test("[3.1] Given 削除ロール When game_roots 以外の表を DELETE する Then 拒否される。持つ DELETE 権限は game_roots だけ") {
            for (table in publicTables().filter { it != "game_roots" }) {
                hasPrivilege(DELETER, table, "DELETE") shouldBe false
            }
            hasPrivilege(DELETER, "game_roots", "DELETE") shouldBe true
            denied(DELETER, "DELETE FROM events")
            denied(DELETER, "DELETE FROM game_join_codes")
            denied(DELETER, "TRUNCATE game_roots")
            denied(DELETER, "UPDATE game_roots SET created_at = created_at")
            denied(DELETER, "INSERT INTO game_roots (game_id, created_at) VALUES ('${UUID.randomUUID()}', now())")
        }

        test("[3.1] Given 観察者ロール When game_join_codes などを SELECT する Then 拒否され、読める表は設計書の 3 表だけ") {
            listOf(
                "game_join_codes",
                "week_role_results",
                "role_current_states",
                "current_decisions",
                "events",
                "credentials",
            ).forEach { deniedQuery(OBSERVER, it) }

            publicTables().filter { hasPrivilege(OBSERVER, it, "SELECT") } shouldContainExactlyInAnyOrder
                OBSERVER_READABLE
            asRole(
                OBSERVER,
            ) { c -> OBSERVER_READABLE.forEach { c.queryList("SELECT count(*) FROM $it") { rs -> rs.getInt(1) } } }
        }

        test("[3.1] Given 観察者と読み取りのロール When 書き込みの権限を調べる Then どの表にも無い") {
            for (role in listOf(OBSERVER, READER)) {
                for (table in publicTables()) {
                    for (privilege in listOf("INSERT", "UPDATE", "DELETE", "TRUNCATE")) {
                        hasPrivilege(role, table, privilege) shouldBe false
                    }
                }
            }
        }

        test("[3.1] Given 読み取りロール When events・資格・冪等記録を SELECT する Then 拒否される（投影の SELECT だけ）") {
            listOf(
                "events",
                "credentials",
                "browser_sessions",
                "idempotency_records",
            ).forEach { deniedQuery(READER, it) }
            asRole(READER) { c -> c.queryList("SELECT count(*) FROM game_join_codes") { it.getInt(1) } }
        }

        test("[3.1] Given 用途別のロール When flyway_schema_history を読む Then 拒否される") {
            APP_ROLES.forEach { deniedQuery(it, "flyway_schema_history") }
        }

        test(
            "[3.1] Given 全表に行を持つゲームと別のゲーム When 削除ロールが game_roots を 1 回 DELETE する Then events に DELETE 権限が無くても連鎖し、game_id を持つ全表からそのゲームの行が消える",
        ) {
            val script = GameScript().create(finalWeek = 2)
            val players = script.joinAllRoles()
            // 1 週を確定した後、次の週の入力を 1 件残す（確定で消える current_decisions にも行を持たせる）。
            script.startGame().playWeek(players).save(players.getValue(Role.RETAILER), Role.RETAILER, 4)
            fx.appendScript(script)
            val other = GameScript().create()
            fx.appendScript(other)
            val id = script.gameId.value
            seedPeripheralRows(id)

            val tables = gameIdTables()
            tables shouldContainAll
                listOf("events", "game_join_codes", "week_role_results", "credentials", "idempotency_records")
            // 空の表が混じると、「行が残らない」の検査が空振りになる。事前に、全表に行があることを確かめる。
            tables.filter { fx.count("$it WHERE game_id = ?", id) == 0 }.shouldBeEmpty()
            hasPrivilege(DELETER, "events", "DELETE") shouldBe false

            val deleted = asRole(DELETER) { it.exec("DELETE FROM game_roots WHERE game_id = '$id'") }

            deleted shouldBe 1
            tables.filter { fx.count("$it WHERE game_id = ?", id) != 0 }.shouldBeEmpty()
            fx.count("events WHERE game_id = ?", other.gameId.value) shouldBe other.events.size
            fx.count("game_roots WHERE game_id = ?", other.gameId.value) shouldBe 1
        }
    })
