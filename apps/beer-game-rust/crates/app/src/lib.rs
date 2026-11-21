//! アプリケーションの組み立て（ワイヤリング）。環境（時計・ID・乱数）と、永続化を `Backend` として HTTP に渡す。

use beergame_adapter_http::Backend;
use beergame_adapter_persistence::PgGameStore;
use beergame_application::{
    AppFailure, AppSettings, Env, GameSnapshot, LobbyParticipantRow, PersistenceFailure, ResultRow,
    RoleSnapshot, SessionSnapshot,
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
}

impl<E: Env + Send + Sync + 'static> PgBackend<E> {
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
            "SELECT s.role, s.inventory, s.backlog, s.arrivals, s.orders, d.quantity, COALESCE(d.decision_version, 0) AS version \
             FROM role_current_states s LEFT JOIN current_decisions d ON d.game_id = s.game_id AND d.role = s.role \
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
            game_version,
            session_version: session_version.unwrap_or(0),
        }))
    }

    async fn game_snapshot(&self, game_id: GameId) -> Result<Option<GameSnapshot>, AppFailure> {
        let game = Uuid::from_u128(game_id.get());
        let Some(row) = sqlx::query(
            "SELECT o.status, o.final_week, o.commit_mode, c.join_code \
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
        let (game_version, session_version) = versions(&self.pool, game).await?;
        Ok(Some(GameSnapshot {
            game_id,
            status: row.try_get("status").map_err(storage)?,
            join_code: row.try_get("join_code").map_err(storage)?,
            final_week: i64::from(row.try_get::<i32, _>("final_week").map_err(storage)?),
            commit_mode: row.try_get("commit_mode").map_err(storage)?,
            participants: list,
            game_version,
            session_version,
        }))
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
