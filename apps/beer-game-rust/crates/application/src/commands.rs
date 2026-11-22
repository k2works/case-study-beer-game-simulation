//! ユースケース（コマンド）。入力の形の検証 → 秘密・ID の生成 → `decide`（ドメイン）→ 追記・周辺ストア。**業務ルールは持たない**。
//! 時計・ID・乱数は `Env` から受け取る（このクレートは読まない）。

use std::future::Future;

use beergame_domain::{
    Actor, AssignOrReplace, CommitMode, ConditionsInput, DecisionVersion, DisplayName, GameCommand,
    GameError, GameEvent, GameId, GameSettings, GameState, Instant, InvitationId, JoinCode,
    ObserverId, ParticipantId, Quantity, RetentionDays, Role, RoleMap, SessionCommand,
    SessionEvent, SessionState, StartGame, Week, assign_or_replace, evolve_game, evolve_session,
};

use crate::{
    AppFailure, CredentialKind, Decision, DomainError, EventStore, Executed, Idempotency,
    PeripheralWrite, SealedFields, SealedIdempotency, Secret, digest, encode_token,
    execute_decision, execute_idempotent, sealed_write,
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
    /// 更新前（旧版）の鍵。ここに残っている間は、その版で発行した資格を使える。外すと使えなくなる（NF-S4）。
    pub retired_keys: Vec<(i32, Secret<Vec<u8>>)>,
    /// ブラウザセッションの有効期間（ミリ秒）。`credential_ttl_millis` は復帰資格の有効期間。
    pub session_ttl_millis: i64,
    /// 参加・復帰の失敗の上限（窓の中。接続元ごと。NF-S11。既定は 10 分に 10 回。未計測の仮置き）。
    pub max_failed_attempts: u32,
    /// 失敗を数える窓の長さ（ミリ秒）。
    pub attempt_window_millis: i64,
}

impl AppSettings {
    /// 資格のダイジェストに使う鍵（現在の版、旧版の順）。
    pub fn keys(&self) -> impl Iterator<Item = (i32, &Secret<Vec<u8>>)> {
        std::iter::once((self.key_version, &self.credential_key)).chain(
            self.retired_keys
                .iter()
                .map(|(version, key)| (*version, key)),
        )
    }
}

/// ゲームの作成の入力（境界で受け取った値）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CreateGameInput {
    pub final_week: i64,
    pub demand: Vec<i64>,
    /// カスタム条件（省略した項目は、キットの値）。
    pub conditions: ConditionsInput,
    /// 確定方式（省略は手動）。
    pub commit_mode: CommitMode,
    /// 保持日数（省略は設定の既定。90 日）。
    pub retention_days: Option<i64>,
}

/// 作成の結果。資格の生の値は、この応答に一度だけ載せる（保存はダイジェストだけ）。
#[derive(Debug)]
pub struct CreateOutcome {
    pub game_id: GameId,
    pub join_code: String,
    /// ブラウザセッション（Cookie）。
    pub facilitator_credential: Secret<String>,
    /// 進行役の復帰コード（応答に一度だけ示す）。
    pub recovery_code: Secret<String>,
    /// 追記後の `game` ストリームの版。
    pub game_version: u64,
}

/// 参加の結果。
#[derive(Debug)]
pub struct JoinOutcome {
    pub participant_id: ParticipantId,
    /// ブラウザセッション（Cookie）。
    pub credential: Secret<String>,
    /// 復帰資格（Cookie）。
    pub recovery_code: Secret<String>,
    /// 追記後の `game` ストリームの版。
    pub game_version: u64,
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

/// 発行した資格（復帰資格とブラウザセッション）。生の値は応答に一度だけ載せ、保存はダイジェストだけ。
struct Issued {
    recovery: Secret<String>,
    session: Secret<String>,
    writes: Vec<PeripheralWrite>,
}

/// 復帰資格とブラウザセッションを発行する（別のダイジェストで持つ）。
fn issue_pair(
    env: &impl Env,
    settings: &AppSettings,
    game_id: GameId,
    kind: CredentialKind,
    subject_id: u128,
    now: Instant,
) -> Result<Issued, AppFailure> {
    let (recovery, recovery_digest) = issue(env, settings)?;
    let (session, session_digest) = issue(env, settings)?;
    let recovery_expires = after(now, settings.credential_ttl_millis);
    let session_expires = after(now, settings.session_ttl_millis);
    let writes = vec![
        PeripheralWrite::Credential {
            digest: recovery_digest,
            game_id,
            kind,
            subject_id,
            key_version: settings.key_version,
            issued_at: now,
            expires_at: recovery_expires,
        },
        PeripheralWrite::BrowserSession {
            digest: session_digest,
            game_id,
            kind,
            subject_id,
            key_version: settings.key_version,
            expires_at: session_expires,
        },
    ];
    Ok(Issued {
        recovery,
        session,
        writes,
    })
}

fn after(now: Instant, millis: i64) -> Instant {
    Instant::from_epoch_millis(now.epoch_millis().saturating_add(millis))
}

/// ゲームの作成（US1.1。匿名）。`game_id` は境界が決める（ストアはゲームごとに作るため）。入力の誤りは、項目ごとにすべて集めて返す（AC1.1.2）。
///
/// # Errors
/// 入力の誤り（`Invalid`）、永続化の失敗。
pub async fn create_game<St: EventStore<GameEvent>>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    game_id: GameId,
    input: &CreateGameInput,
    idem: Option<&SealedIdempotency>,
) -> Result<CreateOutcome, AppFailure> {
    let game_settings = GameSettings::custom(
        input.final_week,
        &input.demand,
        input.commit_mode,
        &input.conditions,
    )
    .map_err(AppFailure::Invalid)?;
    let retention = RetentionDays::of(input.retention_days.unwrap_or(settings.retention_days))
        .map_err(|e| AppFailure::Invalid(vec![e]))?;
    let code_text = env.join_code();
    let join_code = JoinCode::of(&code_text).map_err(|e| AppFailure::Invalid(vec![e]))?;
    let now = env.now();
    let expires = after(now, settings.credential_ttl_millis);
    let issued = issue_pair(
        env,
        settings,
        game_id,
        CredentialKind::Facilitator,
        game_id.get(),
        now,
    )?;
    let command = GameCommand::CreateGame {
        actor: Actor::Anonymous,
        at: now,
        game_id,
        join_code,
        settings: game_settings,
        retention_days: retention,
        facilitator_credential_expires_at: expires,
    };
    let game_version = execute_decision(
        store,
        &GameState::NotCreated,
        &evolve_game,
        &|state, cmd| {
            let events = beergame_domain::decide_game(state, cmd).map_err(domain)?;
            // 同じ `Idempotency-Key` の再送に、同じ応答（同じ資格）を返すための記録（暗号化して保存）
            let mut writes = issued.writes.clone();
            if let Some(idem) = idem {
                let fields = SealedFields {
                    game_version: 1,
                    first: issued.session.clone(),
                    second: issued.recovery.clone(),
                };
                writes.extend(sealed_write(
                    env, settings, game_id, idem, 201, &fields, now,
                ));
            }
            Ok(Decision { events, writes })
        },
        &command,
        settings.max_attempts,
    )
    .await?;
    Ok(CreateOutcome {
        game_id,
        join_code: code_text,
        facilitator_credential: issued.session,
        recovery_code: issued.recovery,
        game_version,
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
    idem: Option<&SealedIdempotency>,
) -> Result<JoinOutcome, AppFailure> {
    let name = DisplayName::of(display_name).map_err(|e| AppFailure::Invalid(vec![e]))?;
    let participant_id = ParticipantId::new(env.new_id());
    let now = env.now();
    let expires = after(now, settings.credential_ttl_millis);
    let issued = issue_pair(
        env,
        settings,
        game_id,
        CredentialKind::Participant,
        participant_id.get(),
        now,
    )?;
    let command = GameCommand::JoinGame {
        actor: Actor::Anonymous,
        at: now,
        participant_id,
        display_name: name.clone(),
        credential_expires_at: expires,
    };
    let game_version = execute_decision(
        store,
        &GameState::NotCreated,
        &evolve_game,
        &|state, cmd| {
            let events = beergame_domain::decide_game(state, cmd).map_err(domain)?;
            let mut writes = issued.writes.clone();
            writes.push(PeripheralWrite::DisplayName {
                game_id,
                participant_id,
                name: name.as_str().to_owned(),
                at: now,
            });
            // 同じ `Idempotency-Key` の再送に、同じ資格を返すための記録（暗号化して保存。版は再送の時点の最新を返す）
            if let Some(idem) = idem {
                let fields = SealedFields {
                    game_version: 0,
                    first: issued.session.clone(),
                    second: issued.recovery.clone(),
                };
                writes.extend(sealed_write(
                    env, settings, game_id, idem, 200, &fields, now,
                ));
            }
            Ok(Decision { events, writes })
        },
        &command,
        settings.max_attempts,
    )
    .await?;
    Ok(JoinOutcome {
        participant_id,
        credential: issued.session,
        recovery_code: issued.recovery,
        game_version,
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
    idem: Option<&Idempotency>,
) -> Result<Executed, AppFailure> {
    let command = GameCommand::AssignRole {
        actor,
        at: env.now(),
        participant_id,
        role,
    };
    execute_idempotent(
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
        idem,
    )
    .await
}

/// 保存されている資格（ダイジェストで引く）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialRecord {
    pub game_id: GameId,
    pub kind: CredentialKind,
    pub subject_id: u128,
    pub expires_at: Instant,
    pub revoked: bool,
    /// 発行に使った鍵の版。
    pub key_version: i32,
}

/// 資格の問い合わせのポート。
pub trait CredentialLookup: Sync {
    /// ブラウザセッションをダイジェストで引く（`revoked` は、対象の復帰資格に有効なものが無いこと）。
    fn find(
        &self,
        digest: &str,
    ) -> impl Future<Output = Result<Option<CredentialRecord>, AppFailure>> + Send;

    /// 復帰資格をダイジェストで引く。
    fn find_recovery(
        &self,
        digest: &str,
    ) -> impl Future<Output = Result<Option<CredentialRecord>, AppFailure>> + Send;
}

/// 復帰のときに、新しいブラウザセッションを書き、復帰資格の期限を更新するポート（1 つのトランザクション）。
pub trait SessionWriter: Sync {
    fn start_session(
        &self,
        recovery_digest: &str,
        session: &PeripheralWrite,
        recovery_expires_at: Instant,
    ) -> impl Future<Output = Result<(), AppFailure>> + Send;
}

fn actor_of(record: &CredentialRecord) -> Actor {
    match record.kind {
        CredentialKind::Facilitator => Actor::Facilitator(record.game_id),
        CredentialKind::Participant => Actor::Participant(ParticipantId::new(record.subject_id)),
        // 観察者のブラウザセッション。招待コードは、認証ではなく参加（`join_observer`）にだけ使う
        CredentialKind::Observer | CredentialKind::ObserverInvitation => {
            Actor::Observer(ObserverId::new(record.subject_id))
        }
    }
}

/// 有効（失効なし・期限内・鍵の版が一致）か。
fn is_valid(record: &CredentialRecord, version: i32, now: Instant) -> bool {
    !record.revoked && record.expires_at > now && record.key_version == version
}

/// 認証。ブラウザセッションの生の値から、鍵の版ごとにダイジェストで引き、有効（存在・失効なし・期限内）なら、操作者とゲームを返す。
/// 現在の鍵と、まだ設定に残っている旧版の鍵を試す。無効な資格は、理由を区別せず `Unauthorized`（列挙の防止）。
///
/// # Errors
/// 資格が無効（`Unauthorized`）、永続化の失敗。
pub async fn authenticate(
    lookup: &impl CredentialLookup,
    env: &impl Env,
    settings: &AppSettings,
    token: &Secret<String>,
) -> Result<(GameId, Actor), AppFailure> {
    for (version, key) in settings.keys() {
        let Some(digest) = digest(key, token) else {
            continue;
        };
        if let Some(record) = lookup.find(&digest).await?
            && is_valid(&record, version, env.now())
        {
            return Ok((record.game_id, actor_of(&record)));
        }
    }
    Err(AppFailure::Unauthorized)
}

/// 復帰の結果。
#[derive(Debug)]
pub struct RecoverOutcome {
    pub game_id: GameId,
    pub actor: Actor,
    /// 新しいブラウザセッション（Cookie）。
    pub session: Secret<String>,
}

/// 復帰（US3.2。復帰資格が認可）。指定のゲームの、有効な復帰資格なら、新しいブラウザセッションを発行し、復帰資格の期限を更新する。
/// 不明・失効・期限切れ・別のゲームは区別せず `Unauthorized`。
///
/// # Errors
/// 資格が無効（`Unauthorized`）、永続化の失敗。
pub async fn recover<S: CredentialLookup + SessionWriter>(
    store: &S,
    env: &impl Env,
    settings: &AppSettings,
    game_id: GameId,
    token: &Secret<String>,
) -> Result<RecoverOutcome, AppFailure> {
    let now = env.now();
    for (version, key) in settings.keys() {
        let Some(recovery_digest) = digest(key, token) else {
            continue;
        };
        let Some(record) = store.find_recovery(&recovery_digest).await? else {
            continue;
        };
        if !is_valid(&record, version, now) || record.game_id != game_id {
            continue;
        }
        let (session, session_digest) = issue(env, settings)?;
        let write = PeripheralWrite::BrowserSession {
            digest: session_digest,
            game_id,
            kind: record.kind,
            subject_id: record.subject_id,
            key_version: settings.key_version,
            expires_at: after(now, settings.session_ttl_millis),
        };
        store
            .start_session(
                &recovery_digest,
                &write,
                after(now, settings.credential_ttl_millis),
            )
            .await?;
        return Ok(RecoverOutcome {
            game_id,
            actor: actor_of(&record),
            session,
        });
    }
    Err(AppFailure::Unauthorized)
}

fn session_domain(e: beergame_domain::SessionError) -> DomainError {
    DomainError::Session(e)
}

async fn run_session<St: EventStore<SessionEvent>>(
    store: &St,
    settings: &AppSettings,
    command: &SessionCommand,
    idem: Option<&Idempotency>,
) -> Result<Executed, AppFailure> {
    execute_idempotent(
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
        idem,
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
    idem: Option<&Idempotency>,
) -> Result<Executed, AppFailure> {
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
        idem,
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
    idem: Option<&Idempotency>,
) -> Result<Executed, AppFailure> {
    run_session(
        store,
        settings,
        &SessionCommand::CommitWeek {
            actor,
            at: env.now(),
            requested_week,
            basis,
        },
        idem,
    )
    .await
}

/// 参加者の資格の失効（US3.2。進行役だけ。準備中・開始後の両方）。復帰資格と発行済みのブラウザセッションをともに使えなくする。
///
/// # Errors
/// 権限・対象・失効済みの誤り、永続化の失敗。
pub async fn revoke_credential<St: EventStore<GameEvent>>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    actor: Actor,
    participant_id: ParticipantId,
    idem: Option<&Idempotency>,
) -> Result<Executed, AppFailure> {
    let command = GameCommand::RevokeCredential {
        actor,
        at: env.now(),
        participant_id,
    };
    execute_idempotent(
        store,
        &GameState::NotCreated,
        &evolve_game,
        &|state, cmd| {
            let game_id = state.data().map(|d| d.game_id);
            Ok(Decision {
                events: beergame_domain::decide_game(state, cmd).map_err(domain)?,
                writes: game_id
                    .map(|game_id| PeripheralWrite::RevokeCredentials {
                        game_id,
                        subject_id: participant_id.get(),
                    })
                    .into_iter()
                    .collect(),
            })
        },
        &command,
        settings.max_attempts,
        idem,
    )
    .await
}

/// 再発行の結果。新しい復帰コードは、この応答で一度だけ示す。
#[derive(Debug)]
pub struct ReissueOutcome {
    pub game_version: u64,
    pub recovery_code: Secret<String>,
    pub expires_at: Instant,
}

/// 参加者の資格の再発行（US3.2。進行役だけ。失効した資格だけ）。
///
/// # Errors
/// 権限・対象・失効していない誤り、永続化の失敗。
pub async fn reissue_credential<St: EventStore<GameEvent>>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    actor: Actor,
    participant_id: ParticipantId,
    idem: Option<&SealedIdempotency>,
) -> Result<ReissueOutcome, AppFailure> {
    let now = env.now();
    let expires_at = after(now, settings.credential_ttl_millis);
    let (token, token_digest) = issue(env, settings)?;
    let command = GameCommand::ReissueCredential {
        actor,
        at: now,
        participant_id,
        credential_expires_at: expires_at,
    };
    let executed = execute_idempotent(
        store,
        &GameState::NotCreated,
        &evolve_game,
        &|state, cmd| {
            let game_id = state.data().map(|d| d.game_id);
            let events = beergame_domain::decide_game(state, cmd).map_err(domain)?;
            let mut writes = Vec::new();
            if let Some(game_id) = game_id {
                writes.push(PeripheralWrite::Credential {
                    digest: token_digest.clone(),
                    game_id,
                    kind: CredentialKind::Participant,
                    subject_id: participant_id.get(),
                    key_version: settings.key_version,
                    issued_at: now,
                    expires_at,
                });
                // 同じ `Idempotency-Key` の再送に、同じ復帰コードを返す（暗号化して保存。版は再送の時点の最新）
                if let Some(idem) = idem {
                    let fields = SealedFields {
                        game_version: 0,
                        first: token.clone(),
                        second: Secret::new(expires_at.epoch_millis().to_string()),
                    };
                    writes.extend(sealed_write(
                        env, settings, game_id, idem, 200, &fields, now,
                    ));
                }
            }
            Ok(Decision { events, writes })
        },
        &command,
        settings.max_attempts,
        None,
    )
    .await?;
    let game_version = match executed {
        Executed::Fresh(version) => version,
        Executed::Replayed(_) => 0,
    };
    Ok(ReissueOutcome {
        game_version,
        recovery_code: token,
        expires_at,
    })
}

/// 確定方式の変更（US2.4。進行役だけ。進行中でも停止中でも）。自動確定を有効にしたとき、入力がそろっていれば同じ追記で確定する。
///
/// # Errors
/// 権限・未開始・終了後の誤り、永続化の失敗。
pub async fn set_commit_mode<St: EventStore<SessionEvent>>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    actor: Actor,
    mode: CommitMode,
    idem: Option<&Idempotency>,
) -> Result<Executed, AppFailure> {
    run_session(
        store,
        settings,
        &SessionCommand::SetCommitMode {
            actor,
            at: env.now(),
            mode,
        },
        idem,
    )
    .await
}

/// 一時停止（US3.1。進行役だけ）。
///
/// # Errors
/// 権限・停止中・未開始・終了後の誤り、永続化の失敗。
pub async fn pause_session<St: EventStore<SessionEvent>>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    actor: Actor,
    idem: Option<&Idempotency>,
) -> Result<Executed, AppFailure> {
    run_session(
        store,
        settings,
        &SessionCommand::PauseSession {
            actor,
            at: env.now(),
        },
        idem,
    )
    .await
}

/// 再開（US3.1。進行役だけ）。
///
/// # Errors
/// 権限・停止中でない・未開始・終了後の誤り、永続化の失敗。
pub async fn resume_session<St: EventStore<SessionEvent>>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    actor: Actor,
    idem: Option<&Idempotency>,
) -> Result<Executed, AppFailure> {
    run_session(
        store,
        settings,
        &SessionCommand::ResumeSession {
            actor,
            at: env.now(),
        },
        idem,
    )
    .await
}

/// 代理入力（US3.1。進行役だけ。停止中も受け付ける）。
///
/// # Errors
/// 権限・週・上限の誤り、永続化の失敗。
#[allow(clippy::too_many_arguments)] // 理由: コマンドの項目をそのまま受け取る（境界で作った値）
pub async fn submit_proxy_decision<St: EventStore<SessionEvent>>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    actor: Actor,
    role: Role,
    requested_week: Week,
    quantity: Quantity,
    idem: Option<&Idempotency>,
) -> Result<Executed, AppFailure> {
    run_session(
        store,
        settings,
        &SessionCommand::SubmitProxyDecision {
            actor,
            at: env.now(),
            role,
            requested_week,
            quantity,
        },
        idem,
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
    idem: Option<&Idempotency>,
) -> Result<crate::StartExecuted, AppFailure>
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
        idem,
    )
    .await
}

/// 役割の割り当て（準備中）と入れ替え（開始後）。開始後の入れ替えは、`game` と `session` の両方へ追記し、外れた旧担当者の
/// 資格（復帰資格とブラウザセッション）を同じトランザクションで失効させる。進行役だけ。
///
/// # Errors
/// 権限・対象・資格の失効・準備中でない・終了後の誤り、永続化の失敗。
pub async fn assign_or_replace_role<St>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    actor: Actor,
    participant_id: ParticipantId,
    role: Role,
    idem: Option<&Idempotency>,
) -> Result<crate::StartExecuted, AppFailure>
where
    St: EventStore<GameEvent> + EventStore<SessionEvent, Tx = <St as EventStore<GameEvent>>::Tx>,
{
    let command = AssignOrReplace {
        actor,
        at: env.now(),
        participant_id,
        role,
    };
    crate::execute_both(
        store,
        &|game, session| {
            let decision = assign_or_replace(game, session, &command)
                .map_err(|e| AppFailure::Domain(DomainError::Start(e)))?;
            // 外れた旧担当者の資格を、同じトランザクションで失効させる
            let writes = game
                .data()
                .map(|data| data.game_id)
                .into_iter()
                .flat_map(|game_id| {
                    decision.game.iter().flat_map(move |event| match event {
                        GameEvent::ParticipantReplaced { replaced, .. } => replaced
                            .iter()
                            .map(|old| PeripheralWrite::RevokeCredentials {
                                game_id,
                                subject_id: old.get(),
                            })
                            .collect::<Vec<_>>(),
                        GameEvent::GameCreated { .. }
                        | GameEvent::ParticipantJoined { .. }
                        | GameEvent::RoleAssigned { .. }
                        | GameEvent::RoleUnassigned { .. }
                        | GameEvent::GameStarted { .. }
                        | GameEvent::ObserverInvited { .. }
                        | GameEvent::ObserverInvitationRevoked { .. }
                        | GameEvent::ObserverJoined { .. }
                        | GameEvent::CredentialRevoked { .. }
                        | GameEvent::CredentialReissued { .. } => Vec::new(),
                    })
                })
                .collect();
            Ok(crate::BothDecision {
                game: decision.game,
                session: decision.session,
                writes,
            })
        },
        settings.max_attempts,
        idem,
    )
    .await
}

/// 観察用の招待の発行の結果。招待コードは、この応答で一度だけ示す。
#[derive(Debug)]
pub struct InviteOutcome {
    pub game_version: u64,
    pub invitation_id: InvitationId,
    pub invitation_code: Secret<String>,
    pub expires_at: Instant,
}

/// 観察用の招待の有効期間（7 日。設計の未決の仮置き）。
const INVITATION_TTL_MILLIS: i64 = 7 * 24 * 60 * 60 * 1000;

/// 観察用の招待の発行（US1.3。進行役だけ。準備中・開始後の両方）。参加コードとは別の乱数・別のダイジェスト。
///
/// # Errors
/// 権限の誤り、永続化の失敗。
pub async fn invite_observer<St: EventStore<GameEvent>>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    actor: Actor,
) -> Result<InviteOutcome, AppFailure> {
    let now = env.now();
    let expires_at = after(now, INVITATION_TTL_MILLIS);
    let invitation_id = InvitationId::new(env.new_id());
    let (code, code_digest) = issue(env, settings)?;
    let command = GameCommand::InviteObserver {
        actor,
        at: now,
        invitation_id,
        expires_at,
    };
    let executed = execute_idempotent(
        store,
        &GameState::NotCreated,
        &evolve_game,
        &|state, cmd| {
            let game_id = state.data().map(|d| d.game_id);
            let events = beergame_domain::decide_game(state, cmd).map_err(domain)?;
            let writes = game_id
                .map(|game_id| PeripheralWrite::Credential {
                    digest: code_digest.clone(),
                    game_id,
                    kind: CredentialKind::ObserverInvitation,
                    subject_id: invitation_id.get(),
                    key_version: settings.key_version,
                    issued_at: now,
                    expires_at,
                })
                .into_iter()
                .collect();
            Ok(Decision { events, writes })
        },
        &command,
        settings.max_attempts,
        None,
    )
    .await?;
    Ok(InviteOutcome {
        game_version: match executed {
            Executed::Fresh(version) => version,
            Executed::Replayed(_) => 0,
        },
        invitation_id,
        invitation_code: code,
        expires_at,
    })
}

/// 観察用の招待の失効（US1.3。進行役だけ）。すでに参加した観察者は、そのまま続けられる。
///
/// # Errors
/// 権限・対象・失効済みの誤り、永続化の失敗。
pub async fn revoke_observer_invitation<St: EventStore<GameEvent>>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    actor: Actor,
    invitation_id: InvitationId,
    idem: Option<&Idempotency>,
) -> Result<Executed, AppFailure> {
    let command = GameCommand::RevokeObserverInvitation {
        actor,
        at: env.now(),
        invitation_id,
    };
    execute_idempotent(
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
        idem,
    )
    .await
}

/// 観察者の参加の結果。
#[derive(Debug)]
pub struct ObserverJoinOutcome {
    pub game_version: u64,
    pub session: Secret<String>,
}

/// 観察者としての参加（US1.3。招待コードが認可）。`invitation_id` は、招待コードのダイジェストから境界が引いた値。
/// ブラウザセッションだけを発行する（復帰資格は発行しない。観察者の復帰は設計の未決）。表示名は周辺ストアへ。
///
/// # Errors
/// 招待が無効（`InvitationInvalid`）、入力の誤り、永続化の失敗。
pub async fn join_observer<St: EventStore<GameEvent>>(
    store: &St,
    env: &impl Env,
    settings: &AppSettings,
    game_id: GameId,
    invitation_id: InvitationId,
    display_name: &str,
) -> Result<ObserverJoinOutcome, AppFailure> {
    let name = DisplayName::of(display_name).map_err(|e| AppFailure::Invalid(vec![e]))?;
    let now = env.now();
    let observer_id = ObserverId::new(env.new_id());
    let (session, session_digest) = issue(env, settings)?;
    let command = GameCommand::JoinAsObserver {
        at: now,
        observer_id,
        invitation_id,
    };
    let game_version = execute_decision(
        store,
        &GameState::NotCreated,
        &evolve_game,
        &|state, cmd| {
            let events = beergame_domain::decide_game(state, cmd).map_err(domain)?;
            Ok(Decision {
                events,
                writes: vec![
                    PeripheralWrite::BrowserSession {
                        digest: session_digest.clone(),
                        game_id,
                        kind: CredentialKind::Observer,
                        subject_id: observer_id.get(),
                        key_version: settings.key_version,
                        expires_at: after(now, settings.session_ttl_millis),
                    },
                    PeripheralWrite::ObserverName {
                        game_id,
                        observer_id,
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
    Ok(ObserverJoinOutcome {
        game_version,
        session,
    })
}

/// 招待コードから、招待（ゲームと招待の ID）を引く。不明・期限切れ・別の種別は `Unauthorized`（失効は `decide` が判定する）。
///
/// # Errors
/// 招待が引けない（`Unauthorized`）、永続化の失敗。
pub async fn find_invitation(
    lookup: &impl CredentialLookup,
    env: &impl Env,
    settings: &AppSettings,
    code: &Secret<String>,
) -> Result<(GameId, InvitationId), AppFailure> {
    for (version, key) in settings.keys() {
        let Some(digest) = digest(key, code) else {
            continue;
        };
        if let Some(record) = lookup.find_recovery(&digest).await?
            && record.kind == CredentialKind::ObserverInvitation
            && record.key_version == version
            && record.expires_at > env.now()
        {
            return Ok((record.game_id, InvitationId::new(record.subject_id)));
        }
    }
    Err(AppFailure::Unauthorized)
}
