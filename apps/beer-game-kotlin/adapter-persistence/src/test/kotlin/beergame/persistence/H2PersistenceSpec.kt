package beergame.persistence

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainAll
import io.kotest.matchers.shouldBe

/**
 * H2（PostgreSQL モード。ローカル開発）の実装が、PostgreSQL と同じ契約を満たすことの確認。
 * 検証の正は PostgreSQL の統合テスト（[beergame.persistence.PostgresPersistenceSpec]）。H2 だけで通る記述は禁止。
 */
class H2PersistenceSpec :
    FunSpec({
        lateinit var fx: Fixture
        beforeSpec { fx = openFixture(Dialect.H2, h2DataSource()) }
        afterSpec { fx.close() }

        test("[7.2] Given 空の H2 When マイグレーションを適用する Then 001〜005 の表が作られ、再適用しても何も変わらない") {
            val tables =
                fx.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'") {
                    it.getString(1)
                }
            tables shouldContainAll
                listOf(
                    "game_roots",
                    "events",
                    "projection_checkpoints",
                    "display_profiles",
                    "credentials",
                    "browser_sessions",
                    "idempotency_records",
                    "game_overview",
                    "game_join_codes",
                    "game_settings",
                    "lobby_participants",
                    "lobby_observer_invitations",
                    "lobby_observers",
                    "session_overview",
                    "role_current_states",
                    "current_decisions",
                    "week_commits",
                    "week_role_results",
                    "week_team_totals",
                    "retention_policies",
                    "deletion_runs",
                    "deletion_attempts",
                    "deletion_receipts",
                    "participation_attempts",
                )
            Migrations.migrate(fx.dataSource, Dialect.H2) shouldBe 0
        }

        test("[5.5] Given 空の H2 When マイグレーションを適用する Then 共通の版が、006（B11 の保持）を空けた順に適用される") {
            fx.query(
                "SELECT script FROM flyway_schema_history " +
                    "WHERE success AND version IS NOT NULL ORDER BY installed_rank",
            ) {
                it.getString(1)
            } shouldBe COMMON_MIGRATIONS
        }

        test("[5.5] Given 空の H2 When マイグレーションを適用する Then lobby_participants に replaced_at（NULL 可）の列がある") {
            fx.query(
                "SELECT is_nullable FROM information_schema.columns " +
                    "WHERE table_name = 'lobby_participants' AND column_name = 'replaced_at'",
            ) { it.getString(1) } shouldBe listOf("YES")
        }

        eventStoreContract { fx }
        transactionContract { fx }
        projectionContract { fx }
        projectionMaintenanceContract { fx }
        retentionContract { fx }
        idempotencyContract { fx }
        projectionLockContract { fx }
        changeNotifierContract { fx }
        applicationFlowContract { fx }
        attemptStoreContract { fx }
        attemptFlowContract { fx }
    })
