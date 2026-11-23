//! アプリケーションの組み立て（ワイヤリング）。環境（時計・ID・乱数）と、永続化を `Backend` として HTTP に渡す。

pub mod config;
pub mod log_capture;
pub mod maintenance_mode;
pub mod runtime_metrics;

use beergame_adapter_http::Backend;
use beergame_adapter_persistence::PgGameStore;
use std::sync::Arc;

use beergame_application::{
    AppFailure, AppSettings, CoHolderRow, EditorSnapshot, Env, GameSnapshot, InvitationRow,
    LobbyParticipantRow, MetricSink, NoMetrics, ObservationSnapshot, ObservedSession, ObserverRow,
    PersistenceFailure, ResultRow, RetentionState, RoleSnapshot, SessionSnapshot, StoredResponse,
    TeamWeekRow,
};
use beergame_domain::{GameId, Instant, ParticipantId, Role};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// 本番の環境。時計はシステム時計、ID と乱数は UUID v4（OS の乱数）。
pub struct SystemEnv;

impl Env for SystemEnv {
    fn now(&self) -> Instant {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
        Instant::from_epoch_millis(millis)
    }

    fn new_id(&self) -> u128 {
        Uuid::new_v4().as_u128()
    }

    fn token_bytes(&self) -> [u8; 32] {
        let mut bytes = [0_u8; 32];
        let (head, tail) = bytes.split_at_mut(16);
        head.copy_from_slice(Uuid::new_v4().as_bytes());
        tail.copy_from_slice(Uuid::new_v4().as_bytes());
        bytes
    }

    fn join_code(&self) -> String {
        // 参加コード: 12 文字（UUID の 16 進。推測困難な乱数から作る）
        Uuid::new_v4()
            .simple()
            .to_string()
            .chars()
            .take(12)
            .collect()
    }
}

/// PostgreSQL の `Backend`。
pub struct PgBackend<E: Env + Send + Sync + 'static> {
    pool: PgPool,
    env: E,
    settings: AppSettings,
    secure_cookies: bool,
    command_timeout: std::time::Duration,
    /// メトリクスの出力先。既定は出さない。
    metrics: Arc<dyn MetricSink>,
}

impl<E: Env + Send + Sync + 'static> PgBackend<E> {
    /// メトリクスの出力先を変える（既定は出さない）。
    #[must_use]
    pub fn with_metrics(mut self, metrics: Arc<dyn MetricSink>) -> Self {
        self.metrics = metrics;
        self
    }

    /// コマンドの応答を待つ上限を変える（既定は 10 秒）。
    #[must_use]
    pub const fn with_command_timeout(mut self, limit: std::time::Duration) -> Self {
        self.command_timeout = limit;
        self
    }

    #[must_use]
    pub fn new(pool: PgPool, env: E, settings: AppSettings, secure_cookies: bool) -> Self {
        PgBackend {
            pool,
            env,
            settings,
            secure_cookies,
            command_timeout: std::time::Duration::from_secs(10),
            metrics: Arc::new(NoMetrics),
        }
    }
}

impl<E: Env + Send + Sync + 'static> Backend for PgBackend<E> {
    type Env = E;
    type Store = PgGameStore;

    fn env(&self) -> &E {
        &self.env
    }

    fn settings(&self) -> &AppSettings {
        &self.settings
    }

    fn store(&self, game_id: GameId) -> PgGameStore {
        PgGameStore::new(self.pool.clone(), Uuid::from_u128(game_id.get()))
            .with_metrics(Arc::clone(&self.metrics))
    }

    fn metrics(&self) -> &dyn MetricSink {
        &*self.metrics
    }

    async fn game_by_join_code(&self, code: &str) -> Result<Option<GameId>, AppFailure> {
        sqlx::query_scalar::<_, Uuid>("SELECT game_id FROM game_join_codes WHERE join_code = $1")
            .bind(code)
            .fetch_optional(&self.pool)
            .await
            .map(|row| row.map(|id| GameId::new(id.as_u128())))
            .map_err(|e| AppFailure::Persistence(PersistenceFailure::Storage(e.to_string())))
    }

    async fn participant_role(
        &self,
        game_id: GameId,
        participant_id: ParticipantId,
    ) -> Result<Option<Role>, AppFailure> {
        let role = sqlx::query_scalar::<_, Option<String>>(
            "SELECT role FROM lobby_participants WHERE participant_id = $1 AND game_id = $2",
        )
        .bind(Uuid::from_u128(participant_id.get()))
        .bind(Uuid::from_u128(game_id.get()))
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppFailure::Persistence(PersistenceFailure::Storage(e.to_string())))?;
        Ok(role.flatten().and_then(|name| {
            Role::ALL.into_iter().find(|r| match r {
                Role::Factory => name == "FACTORY",
                Role::Distributor => name == "DISTRIBUTOR",
                Role::Wholesaler => name == "WHOLESALER",
                Role::Retailer => name == "RETAILER",
            })
        }))
    }

    async fn session_snapshot(
        &self,
        game_id: GameId,
    ) -> Result<Option<SessionSnapshot>, AppFailure> {
        let game = Uuid::from_u128(game_id.get());
        let Some(overview) = sqlx::query(
            "SELECT o.status, o.week, o.submitted_role_count, g.final_week \
             FROM session_overview o JOIN game_overview g USING (game_id) WHERE game_id = $1",
        )
        .bind(game)
        .fetch_optional(&self.pool)
        .await
        .map_err(storage)?
        else {
            return Ok(None);
        };
        let roles = sqlx::query(
            "SELECT s.role, s.inventory, s.backlog, s.arrivals, s.orders, d.quantity, COALESCE(d.decision_version, 0) AS version, \
             d.editor_kind, d.editor_id, p.display_name AS editor_name, \
             (extract(epoch FROM d.updated_at) * 1000)::bigint AS saved_ms \
             FROM role_current_states s LEFT JOIN current_decisions d ON d.game_id = s.game_id AND d.role = s.role \
             LEFT JOIN display_profiles p ON p.game_id = s.game_id AND p.actor_kind = 'PARTICIPANT' AND p.actor_id = d.editor_id \
             WHERE s.game_id = $1",
        )
        .bind(game)
        .fetch_all(&self.pool)
        .await
        .map_err(storage)?;
        let mut role_rows = Vec::new();
        for row in &roles {
            let name: String = row.try_get("role").map_err(storage)?;
            let Some(role) = role_of_text(&name) else {
                continue;
            };
            role_rows.push(RoleSnapshot {
                role,
                inventory: i64::from(row.try_get::<i32, _>("inventory").map_err(storage)?),
                backlog: i64::from(row.try_get::<i32, _>("backlog").map_err(storage)?),
                arrivals: i64::from(row.try_get::<i32, _>("arrivals").map_err(storage)?),
                orders: i64::from(row.try_get::<i32, _>("orders").map_err(storage)?),
                decision: row
                    .try_get::<Option<i32>, _>("quantity")
                    .map_err(storage)?
                    .map(i64::from),
                decision_version: row.try_get::<i64, _>("version").map_err(storage)?,
                editor: editor_of(row)?,
                saved_at_millis: row.try_get::<Option<i64>, _>("saved_ms").map_err(storage)?,
            });
        }
        role_rows.sort_by_key(|r| r.role);
        let results = sqlx::query(
            "SELECT week, role, demand, ordered, ending_inventory, ending_backlog, shipped, weekly_cost_minor, cumulative_cost_minor \
             FROM week_role_results WHERE game_id = $1",
        )
        .bind(game)
        .fetch_all(&self.pool)
        .await
        .map_err(storage)?;
        let mut result_rows = Vec::new();
        for row in &results {
            let name: String = row.try_get("role").map_err(storage)?;
            let Some(role) = role_of_text(&name) else {
                continue;
            };
            result_rows.push(ResultRow {
                role,
                week: i64::from(row.try_get::<i32, _>("week").map_err(storage)?),
                orders: i64::from(row.try_get::<i32, _>("demand").map_err(storage)?),
                order: i64::from(row.try_get::<i32, _>("ordered").map_err(storage)?),
                inventory: i64::from(row.try_get::<i32, _>("ending_inventory").map_err(storage)?),
                backlog: i64::from(row.try_get::<i32, _>("ending_backlog").map_err(storage)?),
                shipment: i64::from(row.try_get::<i32, _>("shipped").map_err(storage)?),
                cost: i64::from(
                    row.try_get::<i32, _>("weekly_cost_minor")
                        .map_err(storage)?,
                ),
                cumulative_cost: row
                    .try_get::<i64, _>("cumulative_cost_minor")
                    .map_err(storage)?,
            });
        }
        result_rows.sort_by_key(|r| (r.week, r.role));
        let holders = sqlx::query(
            "SELECT p.role, p.participant_id, d.display_name FROM lobby_participants p \
             LEFT JOIN display_profiles d ON d.game_id = p.game_id AND d.actor_kind = 'PARTICIPANT' AND d.actor_id = p.participant_id \
             WHERE p.game_id = $1 AND p.role IS NOT NULL ORDER BY p.joined_at, p.participant_id",
        )
        .bind(game)
        .fetch_all(&self.pool)
        .await
        .map_err(storage)?;
        let mut co_holders = Vec::new();
        for row in &holders {
            let name: String = row.try_get("role").map_err(storage)?;
            let Some(role) = role_of_text(&name) else {
                continue;
            };
            let id: Uuid = row.try_get("participant_id").map_err(storage)?;
            co_holders.push(CoHolderRow {
                role,
                participant_id: ParticipantId::new(id.as_u128()),
                display_name: row.try_get("display_name").map_err(storage)?,
            });
        }
        let (game_version, session_version) = versions(&self.pool, game).await?;
        Ok(Some(SessionSnapshot {
            game_id,
            status: overview.try_get("status").map_err(storage)?,
            week: i64::from(overview.try_get::<i32, _>("week").map_err(storage)?),
            submitted_role_count: i64::from(
                overview
                    .try_get::<i32, _>("submitted_role_count")
                    .map_err(storage)?,
            ),
            final_week: i64::from(overview.try_get::<i32, _>("final_week").map_err(storage)?),
            roles: role_rows,
            results: result_rows,
            co_holders,
            game_version,
            session_version: session_version.unwrap_or(0),
        }))
    }

    async fn game_snapshot(&self, game_id: GameId) -> Result<Option<GameSnapshot>, AppFailure> {
        let game = Uuid::from_u128(game_id.get());
        let Some(row) = sqlx::query(
            "SELECT o.status, o.final_week, o.commit_mode, o.settings_kind, ARRAY(SELECT jsonb_array_elements_text(o.settings_changes)) AS changes, c.join_code \
             FROM game_overview o JOIN game_join_codes c USING (game_id) WHERE game_id = $1",
        )
        .bind(game)
        .fetch_optional(&self.pool)
        .await
        .map_err(storage)?
        else {
            return Ok(None);
        };
        let participants = sqlx::query(
            "SELECT p.participant_id, p.role, d.display_name FROM lobby_participants p \
             LEFT JOIN display_profiles d ON d.game_id = p.game_id AND d.actor_kind = 'PARTICIPANT' AND d.actor_id = p.participant_id \
             WHERE p.game_id = $1 ORDER BY p.joined_at, p.participant_id",
        )
        .bind(game)
        .fetch_all(&self.pool)
        .await
        .map_err(storage)?;
        let mut list = Vec::new();
        for p in &participants {
            let id: Uuid = p.try_get("participant_id").map_err(storage)?;
            let role: Option<String> = p.try_get("role").map_err(storage)?;
            list.push(LobbyParticipantRow {
                participant_id: ParticipantId::new(id.as_u128()),
                role: role.as_deref().and_then(role_of_text),
                display_name: p.try_get("display_name").map_err(storage)?,
            });
        }
        let invitation_rows = sqlx::query(
            "SELECT invitation_id, (extract(epoch FROM expires_at) * 1000)::bigint AS expires_ms, \
             revoked_at IS NOT NULL AS revoked, (extract(epoch FROM created_at) * 1000)::bigint AS created_ms \
             FROM lobby_observer_invitations WHERE game_id = $1 ORDER BY created_at, invitation_id",
        )
        .bind(game)
        .fetch_all(&self.pool)
        .await
        .map_err(storage)?;
        let mut invitations = Vec::new();
        for row in &invitation_rows {
            invitations.push(InvitationRow {
                invitation_id: row
                    .try_get::<Uuid, _>("invitation_id")
                    .map_err(storage)?
                    .as_u128(),
                expires_at_millis: row.try_get("expires_ms").map_err(storage)?,
                revoked: row.try_get("revoked").map_err(storage)?,
                created_at_millis: row.try_get("created_ms").map_err(storage)?,
            });
        }
        let observer_rows = sqlx::query(
            "SELECT o.observer_id, (extract(epoch FROM o.joined_at) * 1000)::bigint AS joined_ms, d.display_name FROM lobby_observers o \
             LEFT JOIN display_profiles d ON d.game_id = o.game_id AND d.actor_kind = 'OBSERVER' AND d.actor_id = o.observer_id \
             WHERE o.game_id = $1 ORDER BY o.joined_at, o.observer_id",
        )
        .bind(game)
        .fetch_all(&self.pool)
        .await
        .map_err(storage)?;
        let mut observers = Vec::new();
        for row in &observer_rows {
            observers.push(ObserverRow {
                observer_id: row
                    .try_get::<Uuid, _>("observer_id")
                    .map_err(storage)?
                    .as_u128(),
                display_name: row.try_get("display_name").map_err(storage)?,
                joined_at_millis: row.try_get("joined_ms").map_err(storage)?,
            });
        }
        let (game_version, session_version) = versions(&self.pool, game).await?;
        Ok(Some(GameSnapshot {
            game_id,
            status: row.try_get("status").map_err(storage)?,
            join_code: row.try_get("join_code").map_err(storage)?,
            final_week: i64::from(row.try_get::<i32, _>("final_week").map_err(storage)?),
            commit_mode: row.try_get("commit_mode").map_err(storage)?,
            settings_kind: row.try_get("settings_kind").map_err(storage)?,
            changed_settings: row.try_get("changes").map_err(storage)?,
            participants: list,
            invitations,
            observers,
            game_version,
            session_version,
        }))
    }

    async fn observation_snapshot(
        &self,
        game_id: GameId,
    ) -> Result<Option<ObservationSnapshot>, AppFailure> {
        let game = Uuid::from_u128(game_id.get());
        // 観察者向けの表だけ（`game_overview`・`session_overview`・`week_team_totals`）と、公開範囲（`game_settings`）から作る
        let Some(overview) = sqlx::query(
            "SELECT o.status, o.final_week, COALESCE(s.disclosure_policy, 'TEAM_TOTAL') AS disclosure \
             FROM game_overview o LEFT JOIN game_settings s USING (game_id) WHERE game_id = $1",
        )
        .bind(game)
        .fetch_optional(&self.pool)
        .await
        .map_err(storage)?
        else {
            return Ok(None);
        };
        let session = sqlx::query(
            "SELECT status, week, submitted_role_count FROM session_overview WHERE game_id = $1",
        )
        .bind(game)
        .fetch_optional(&self.pool)
        .await
        .map_err(storage)?;
        let session = match session {
            Some(row) => Some(ObservedSession {
                status: row.try_get("status").map_err(storage)?,
                week: i64::from(row.try_get::<i32, _>("week").map_err(storage)?),
                submitted_role_count: i64::from(
                    row.try_get::<i32, _>("submitted_role_count")
                        .map_err(storage)?,
                ),
            }),
            None => None,
        };
        let rows = sqlx::query(
            "SELECT week, total_ordered, total_inventory, total_backlog, contributors FROM week_team_totals \
             WHERE game_id = $1 ORDER BY week",
        )
        .bind(game)
        .fetch_all(&self.pool)
        .await
        .map_err(storage)?;
        let mut weeks = Vec::new();
        for row in &rows {
            weeks.push(TeamWeekRow {
                week: i64::from(row.try_get::<i32, _>("week").map_err(storage)?),
                ordered: i64::from(row.try_get::<i32, _>("total_ordered").map_err(storage)?),
                inventory: i64::from(row.try_get::<i32, _>("total_inventory").map_err(storage)?),
                backlog: i64::from(row.try_get::<i32, _>("total_backlog").map_err(storage)?),
                contributors: i64::from(row.try_get::<i32, _>("contributors").map_err(storage)?),
            });
        }
        let (game_version, session_version) = versions(&self.pool, game).await?;
        Ok(Some(ObservationSnapshot {
            game_id,
            status: overview.try_get("status").map_err(storage)?,
            final_week: i64::from(overview.try_get::<i32, _>("final_week").map_err(storage)?),
            session,
            disclosure: overview.try_get("disclosure").map_err(storage)?,
            weeks,
            game_version,
            session_version,
        }))
    }

    async fn retention_state(&self, game_id: GameId) -> Result<Option<RetentionState>, AppFailure> {
        let row = sqlx::query(
            "SELECT p.retention_days, (extract(epoch FROM p.retention_starts_at) * 1000)::bigint AS starts_ms, \
             (extract(epoch FROM p.delete_after) * 1000)::bigint AS delete_ms, r.status, r.attempt, \
             (extract(epoch FROM r.next_attempt_at) * 1000)::bigint AS next_ms, r.last_failure_code \
             FROM retention_policies p LEFT JOIN deletion_runs r ON r.game_id = p.game_id WHERE p.game_id = $1",
        )
        .bind(Uuid::from_u128(game_id.get()))
        .fetch_optional(&self.pool)
        .await
        .map_err(storage)?;
        let Some(row) = row else { return Ok(None) };
        let run_status: Option<String> = row.try_get("status").map_err(storage)?;
        let next: Option<i64> = row.try_get("next_ms").map_err(storage)?;
        // 予定（まだ試行していない）・削除中・再試行待ち・再試行の上限に達した（再試行の時刻が無い）
        let status = match (run_status.as_deref(), next) {
            (None, _) => "SCHEDULED",
            (Some("IN_PROGRESS"), _) => "IN_PROGRESS",
            (Some(_), Some(_)) => "RETRY_PENDING",
            (Some(_), None) => "ABANDONED",
        };
        Ok(Some(RetentionState {
            retention_days: i64::from(row.try_get::<i32, _>("retention_days").map_err(storage)?),
            starts_at_millis: row.try_get("starts_ms").map_err(storage)?,
            delete_after_millis: row.try_get("delete_ms").map_err(storage)?,
            status: status.to_owned(),
            attempt: row
                .try_get::<Option<i32>, _>("attempt")
                .map_err(storage)?
                .map_or(0, i64::from),
            next_attempt_at_millis: if status == "RETRY_PENDING" {
                next
            } else {
                None
            },
            last_failure_code: row.try_get("last_failure_code").map_err(storage)?,
        }))
    }

    async fn note_attempt(
        &self,
        scope: &str,
        key_digest: &str,
        window_start: Instant,
    ) -> Result<i64, AppFailure> {
        sqlx::query_scalar::<_, i32>(
            "INSERT INTO participation_attempts (scope, key_digest, window_start, failure_count) \
             VALUES ($1, $2, to_timestamp($3::double precision / 1000), 1) \
             ON CONFLICT (scope, key_digest, window_start) \
             DO UPDATE SET failure_count = participation_attempts.failure_count + 1 \
             RETURNING failure_count",
        )
        .bind(scope)
        .bind(key_digest)
        .bind(window_start.epoch_millis())
        .fetch_one(&self.pool)
        .await
        .map(i64::from)
        .map_err(storage)
    }

    async fn forgive_attempt(
        &self,
        scope: &str,
        key_digest: &str,
        window_start: Instant,
    ) -> Result<(), AppFailure> {
        sqlx::query(
            "UPDATE participation_attempts SET failure_count = GREATEST(failure_count - 1, 0) \
             WHERE scope = $1 AND key_digest = $2 AND window_start = to_timestamp($3::double precision / 1000)",
        )
        .bind(scope)
        .bind(key_digest)
        .bind(window_start.epoch_millis())
        .execute(&self.pool)
        .await
        .map(|_| ())
        .map_err(storage)
    }

    async fn stored_response(
        &self,
        game_id: Option<GameId>,
        scope: &str,
        key_digest: &str,
    ) -> Result<Option<(GameId, StoredResponse)>, AppFailure> {
        // 期限内の記録だけ。作成は、ゲームがまだ分からないので、(scope, key_digest) だけで引く（部分一意索引 uq_idempotency_create）
        let row = sqlx::query(
            "SELECT game_id, request_digest, status_code, response FROM idempotency_records \
             WHERE scope = $1 AND key_digest = $2 AND ($3::uuid IS NULL OR game_id = $3) AND expires_at > now()",
        )
        .bind(scope)
        .bind(key_digest)
        .bind(game_id.map(|g| Uuid::from_u128(g.get())))
        .fetch_optional(&self.pool)
        .await
        .map_err(storage)?;
        let Some(row) = row else { return Ok(None) };
        let found: Uuid = row.try_get("game_id").map_err(storage)?;
        let status: i32 = row.try_get("status_code").map_err(storage)?;
        Ok(Some((
            GameId::new(found.as_u128()),
            StoredResponse {
                request_digest: row.try_get("request_digest").map_err(storage)?,
                status_code: u16::try_from(status).unwrap_or(500),
                body: row.try_get("response").map_err(storage)?,
            },
        )))
    }

    async fn is_ready(&self) -> bool {
        sqlx::query_scalar::<_, i32>("SELECT 1")
            .fetch_one(&self.pool)
            .await
            .is_ok()
    }

    fn command_timeout(&self) -> std::time::Duration {
        self.command_timeout
    }

    fn secure_cookies(&self) -> bool {
        self.secure_cookies
    }
}

/// 当週の入力の保存者（`current_decisions` の行）。未入力なら `None`。
fn editor_of(row: &sqlx::postgres::PgRow) -> Result<Option<EditorSnapshot>, AppFailure> {
    let kind: Option<String> = row.try_get("editor_kind").map_err(storage)?;
    let id: Option<Uuid> = row.try_get("editor_id").map_err(storage)?;
    Ok(match (kind.as_deref(), id) {
        (Some("FACILITATOR"), _) => Some(EditorSnapshot {
            is_proxy: true,
            participant_id: None,
            display_name: None,
        }),
        (Some("PARTICIPANT"), Some(id)) => Some(EditorSnapshot {
            is_proxy: false,
            participant_id: Some(ParticipantId::new(id.as_u128())),
            display_name: row.try_get("editor_name").map_err(storage)?,
        }),
        _ => None,
    })
}

fn storage(e: sqlx::Error) -> AppFailure {
    AppFailure::Persistence(PersistenceFailure::Storage(e.to_string()))
}

fn role_of_text(name: &str) -> Option<Role> {
    Role::ALL.into_iter().find(|r| match r {
        Role::Factory => name == "FACTORY",
        Role::Distributor => name == "DISTRIBUTOR",
        Role::Wholesaler => name == "WHOLESALER",
        Role::Retailer => name == "RETAILER",
    })
}

/// ストリームごとの最新の版（`game` は必ずある。`session` は開始前は `None`）。
async fn versions(pool: &PgPool, game: Uuid) -> Result<(u64, Option<u64>), AppFailure> {
    let rows = sqlx::query("SELECT stream_type, max(stream_version) AS v FROM events WHERE game_id = $1 GROUP BY stream_type")
        .bind(game)
        .fetch_all(pool)
        .await
        .map_err(storage)?;
    let mut game_version = 0_u64;
    let mut session_version = None;
    for row in &rows {
        let stream: String = row.try_get("stream_type").map_err(storage)?;
        let v = u64::try_from(row.try_get::<i64, _>("v").map_err(storage)?).unwrap_or(0);
        if stream == "GAME" {
            game_version = v;
        } else {
            session_version = Some(v);
        }
    }
    Ok((game_version, session_version))
}

/// 構造化ログ（JSON）を標準出力へ出す。ログの型には、表示名・資格を持たせない（各ルートは、相関 ID・操作・結果・所要時間だけを出す）。
pub fn init_logging() {
    tracing_subscriber::fmt().json().with_target(true).init();
}
