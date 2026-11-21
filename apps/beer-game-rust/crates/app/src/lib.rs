//! アプリケーションの組み立て（ワイヤリング）。環境（時計・ID・乱数）と、永続化を `Backend` として HTTP に渡す。

use beergame_adapter_http::Backend;
use beergame_adapter_persistence::PgGameStore;
use beergame_application::{AppFailure, AppSettings, Env, PersistenceFailure};
use beergame_domain::{GameId, Instant, ParticipantId, Role};
use sqlx::PgPool;
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
}

impl<E: Env + Send + Sync + 'static> PgBackend<E> {
    #[must_use]
    pub fn new(pool: PgPool, env: E, settings: AppSettings, secure_cookies: bool) -> Self {
        PgBackend {
            pool,
            env,
            settings,
            secure_cookies,
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

    async fn is_ready(&self) -> bool {
        sqlx::query_scalar::<_, i32>("SELECT 1")
            .fetch_one(&self.pool)
            .await
            .is_ok()
    }

    fn secure_cookies(&self) -> bool {
        self.secure_cookies
    }
}
