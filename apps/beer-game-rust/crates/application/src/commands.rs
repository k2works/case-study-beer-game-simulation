//! ユースケース（コマンド）。入力の形の検証 → 秘密・ID の生成 → `decide`（ドメイン）→ 追記・周辺ストア。**業務ルールは持たない**。
//! 時計・ID・乱数は `Env` から受け取る（このクレートは読まない）。

use std::future::Future;

use beergame_domain::{
    Actor, CommitMode, DecisionVersion, DisplayName, GameCommand, GameError, GameEvent, GameId,
    GameSettings, GameState, Instant, JoinCode, ParticipantId, Quantity, RetentionDays, Role,
    RoleMap, SessionCommand, SessionEvent, SessionState, StartGame, Week, evolve_game,
    evolve_session,
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

/// 保存されている資格（ダイジェストで引く）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialRecord {
    pub game_id: GameId,
    pub kind: CredentialKind,
    pub subject_id: u128,
    pub expires_at: Instant,
    pub revoked: bool,
}

/// 資格の問い合わせのポート。
pub trait CredentialLookup: Sync {
    fn find(
        &self,
        digest: &str,
    ) -> impl Future<Output = Result<Option<CredentialRecord>, AppFailure>> + Send;
}

/// 認証。資格の生の値から、ダイジェストで資格を引き、有効（存在・失効なし・期限内）なら、操作者とゲームを返す。
/// 無効な資格は、理由を区別せず `Unauthorized`（列挙の防止）。
///
/// # Errors
/// 資格が無効（`Unauthorized`）、永続化の失敗。
pub async fn authenticate(
    lookup: &impl CredentialLookup,
    env: &impl Env,
    settings: &AppSettings,
    token: &Secret<String>,
) -> Result<(GameId, Actor), AppFailure> {
    let Some(digest) = digest(&settings.credential_key, token) else {
        return Err(AppFailure::Unauthorized);
    };
    match lookup.find(&digest).await? {
        Some(record) if !record.revoked && record.expires_at > env.now() => {
            let actor = match record.kind {
                CredentialKind::Facilitator => Actor::Facilitator(record.game_id),
                CredentialKind::Participant => {
                    Actor::Participant(ParticipantId::new(record.subject_id))
                }
            };
            Ok((record.game_id, actor))
        }
        Some(_) | None => Err(AppFailure::Unauthorized),
    }
}

fn session_domain(e: beergame_domain::SessionError) -> DomainError {
    DomainError::Session(e)
}

async fn run_session<St: EventStore<SessionEvent>>(
    store: &St,
    settings: &AppSettings,
    command: &SessionCommand,
) -> Result<u64, AppFailure> {
    execute_decision(
        store,
        &SessionState::NotStarted,
        &evolve_session,
        &|state, cmd| {
            Ok(Decision {
                events: beergame_domain::decide_session(state, cmd).map_err(session_domain)?,
                writes: Vec::new(),
            })
        },
        command,
        settings.max_attempts,
    )
    .await
}

/// 意思決定の保存（US2.2。その役割の参加者だけ）。
///
/// # Errors
/// 権限・週・版・上限の誤り、永続化の失敗。
#[allow(clippy::too_many_arguments)] // 理由: コマンドの項目をそのまま受け取る（境界で作った値）
pub async fn save_decision<St: EventStore<SessionEvent>>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    actor: Actor,
    role: Role,
    requested_week: Week,
    quantity: Quantity,
    expected_decision_version: DecisionVersion,
) -> Result<u64, AppFailure> {
    run_session(
        store,
        settings,
        &SessionCommand::SaveDecision {
            actor,
            at: env.now(),
            role,
            requested_week,
            quantity,
            expected_decision_version,
        },
    )
    .await
}

/// 週の確定（US2.3。進行役だけ。手動）。
///
/// # Errors
/// 権限・週・入力の不足・根拠の版の誤り、永続化の失敗。
pub async fn commit_week<St: EventStore<SessionEvent>>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    actor: Actor,
    requested_week: Week,
    basis: RoleMap<DecisionVersion>,
) -> Result<u64, AppFailure> {
    run_session(
        store,
        settings,
        &SessionCommand::CommitWeek {
            actor,
            at: env.now(),
            requested_week,
            basis,
        },
    )
    .await
}

/// ゲームの開始（US1.2。進行役だけ）。`game` と `session` の 2 本へ 1 つのトランザクションで追記する。
///
/// # Errors
/// 権限・開始条件・開始済みの誤り、永続化の失敗。
pub async fn start_game<St>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    actor: Actor,
) -> Result<(u64, u64), AppFailure>
where
    St: EventStore<GameEvent> + EventStore<SessionEvent, Tx = <St as EventStore<GameEvent>>::Tx>,
{
    crate::execute_start(
        store,
        &StartGame {
            actor,
            at: env.now(),
        },
        settings.max_attempts,
    )
    .await
}
