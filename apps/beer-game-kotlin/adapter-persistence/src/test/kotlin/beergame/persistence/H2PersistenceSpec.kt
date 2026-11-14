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
                )
            Migrations.migrate(fx.dataSource, Dialect.H2) shouldBe 0
        }

        eventStoreContract { fx }
        transactionContract { fx }
        projectionContract { fx }
        idempotencyContract { fx }
        projectionLockContract { fx }
        changeNotifierContract { fx }
    })
