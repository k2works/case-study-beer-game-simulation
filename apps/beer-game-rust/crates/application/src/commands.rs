//! ユースケース（コマンド）。入力の形の検証 → 秘密・ID の生成 → `decide`（ドメイン）→ 追記・周辺ストア。**業務ルールは持たない**。
//! 時計・ID・乱数は `Env` から受け取る（このクレートは読まない）。

use beergame_domain::{
    Actor, CommitMode, DisplayName, GameCommand, GameError, GameEvent, GameId, GameSettings,
    GameState, Instant, JoinCode, ParticipantId, RetentionDays, Role, evolve_game,
};

use crate::{
    AppFailure, CredentialKind, Decision, DomainError, EventStore, PeripheralWrite, Secret, digest,
    encode_token, execute_decision,
};

/// 外の世界（時計・ID・乱数）。テストでは固定の実装に差し替える。
pub trait Env: Sync {
    fn now(&self) -> Instant;
    /// 新しい識別子（UUID の 128 ビット値）。
    fn new_id(&self) -> u128;
    /// 資格の元になる 256 ビットの乱数。
    fn token_bytes(&self) -> [u8; 32];
    /// 参加コード（推測困難な 8 文字以上）。
    fn join_code(&self) -> String;
}

/// アプリケーションの設定。
pub struct AppSettings {
    /// 資格のダイジェストの鍵（空は設定の誤り）。
    pub credential_key: Secret<Vec<u8>>,
    pub key_version: i32,
    /// 資格の有効期間（ミリ秒）。
    pub credential_ttl_millis: i64,
    pub retention_days: i64,
    /// 追記の競合の再試行の上限。
    pub max_attempts: u32,
}

/// ゲームの作成の入力（境界で受け取った値）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateGameInput {
    pub final_week: i64,
    pub demand: Vec<i64>,
}

/// 作成の結果。資格の生の値は、この応答に一度だけ載せる（保存はダイジェストだけ）。
#[derive(Debug)]
pub struct CreateOutcome {
    pub game_id: GameId,
    pub join_code: String,
    pub facilitator_credential: Secret<String>,
}

/// 参加の結果。
#[derive(Debug)]
pub struct JoinOutcome {
    pub participant_id: ParticipantId,
    pub credential: Secret<String>,
}

fn domain(e: GameError) -> DomainError {
    DomainError::Game(e)
}

fn issue(env: &impl Env, settings: &AppSettings) -> Result<(Secret<String>, String), AppFailure> {
    let token = encode_token(&env.token_bytes());
    let digest = digest(&settings.credential_key, &token).ok_or_else(|| {
        AppFailure::Persistence(crate::PersistenceFailure::Storage(
            "資格の鍵が設定されていない".to_owned(),
        ))
    })?;
    Ok((token, digest))
}

/// ゲームの作成（US1.1。匿名）。入力の誤りは、項目ごとにすべて集めて返す（AC1.1.2）。
///
/// # Errors
/// 入力の誤り（`Invalid`）、永続化の失敗。
pub async fn create_game<St: EventStore<GameEvent>>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    input: &CreateGameInput,
) -> Result<CreateOutcome, AppFailure> {
    let game_settings = GameSettings::kit(input.final_week, &input.demand, CommitMode::Manual)
        .map_err(AppFailure::Invalid)?;
    let retention =
        RetentionDays::of(settings.retention_days).map_err(|e| AppFailure::Invalid(vec![e]))?;
    let game_id = GameId::new(env.new_id());
    let code_text = env.join_code();
    let join_code = JoinCode::of(&code_text).map_err(|e| AppFailure::Invalid(vec![e]))?;
    let (token, token_digest) = issue(env, settings)?;
    let now = env.now();
    let expires = Instant::from_epoch_millis(
        now.epoch_millis()
            .saturating_add(settings.credential_ttl_millis),
    );
    let command = GameCommand::CreateGame {
        actor: Actor::Anonymous,
        at: now,
        game_id,
        join_code,
        settings: game_settings,
        retention_days: retention,
        facilitator_credential_expires_at: expires,
    };
    execute_decision(
        store,
        &GameState::NotCreated,
        &evolve_game,
        &|state, cmd| {
            let events = beergame_domain::decide_game(state, cmd).map_err(domain)?;
            Ok(Decision {
                events,
                writes: vec![PeripheralWrite::Credential {
                    digest: token_digest.clone(),
                    game_id,
                    kind: CredentialKind::Facilitator,
                    subject_id: game_id.get(),
                    key_version: settings.key_version,
                    issued_at: now,
                    expires_at: expires,
                }],
            })
        },
        &command,
        settings.max_attempts,
    )
    .await?;
    Ok(CreateOutcome {
        game_id,
        join_code: code_text,
        facilitator_credential: token,
    })
}

/// 参加（US1.2。匿名）。参加コードからゲームを引くのは境界（問い合わせ）が行い、ここには `game_id` が渡る。
/// 表示名はイベントに入れず、周辺ストアへ書く（NF-S14）。
///
/// # Errors
/// 入力の誤り（`Invalid`）、受付の終了（`Domain(NotPreparing)`）、永続化の失敗。
pub async fn join_game<St: EventStore<GameEvent>>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    game_id: GameId,
    display_name: &str,
) -> Result<JoinOutcome, AppFailure> {
    let name = DisplayName::of(display_name).map_err(|e| AppFailure::Invalid(vec![e]))?;
    let participant_id = ParticipantId::new(env.new_id());
    let (token, token_digest) = issue(env, settings)?;
    let now = env.now();
    let expires = Instant::from_epoch_millis(
        now.epoch_millis()
            .saturating_add(settings.credential_ttl_millis),
    );
    let command = GameCommand::JoinGame {
        actor: Actor::Anonymous,
        at: now,
        participant_id,
        display_name: name.clone(),
        credential_expires_at: expires,
    };
    execute_decision(
        store,
        &GameState::NotCreated,
        &evolve_game,
        &|state, cmd| {
            let events = beergame_domain::decide_game(state, cmd).map_err(domain)?;
            Ok(Decision {
                events,
                writes: vec![
                    PeripheralWrite::Credential {
                        digest: token_digest.clone(),
                        game_id,
                        kind: CredentialKind::Participant,
                        subject_id: participant_id.get(),
                        key_version: settings.key_version,
                        issued_at: now,
                        expires_at: expires,
                    },
                    PeripheralWrite::DisplayName {
                        game_id,
                        participant_id,
                        name: name.as_str().to_owned(),
                        at: now,
                    },
                ],
            })
        },
        &command,
        settings.max_attempts,
    )
    .await?;
    Ok(JoinOutcome {
        participant_id,
        credential: token,
    })
}

/// 役割の割り当て（US1.2。進行役だけ）。
///
/// # Errors
/// 権限・参加者・状態の誤り、永続化の失敗。
pub async fn assign_role<St: EventStore<GameEvent>>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    actor: Actor,
    participant_id: ParticipantId,
    role: Role,
) -> Result<(), AppFailure> {
    let command = GameCommand::AssignRole {
        actor,
        at: env.now(),
        participant_id,
        role,
    };
    execute_decision(
        store,
        &GameState::NotCreated,
        &evolve_game,
        &|state, cmd| {
            Ok(Decision {
                events: beergame_domain::decide_game(state, cmd).map_err(domain)?,
                writes: Vec::new(),
            })
        },
        &command,
        settings.max_attempts,
    )
    .await
    .map(|_| ())
}
