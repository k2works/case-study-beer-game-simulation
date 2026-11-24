//! Game 集約（準備。ストリーム `game`）。B1 の範囲: 作成、参加、役割の割り当て、開始（`start_game` が `GameStarted` を作る）。
//! 資格・観察者・開始後の入れ替えは後続の Bolt。

use std::collections::{BTreeMap, BTreeSet};

use crate::conditions::{Conditions, ConditionsInput, SettingsField, SettingsKind};
use crate::error::ValidationError;
use crate::foundation::{Actor, ErrorCategory, Evolution};
use crate::kit_preset::KitPreset;
use crate::role::{Role, RoleMap};
use crate::settings::{CostPolicy, DemandSeries};
use crate::simulate::SimulationSettings;
use crate::values::{
    DisplayName, GameId, Instant, InvitationId, JoinCode, ObserverId, ParticipantId, RetentionDays,
    Week,
};

/// 確定方式。手動（進行役が確定する）か、自動（4 役割の入力がそろったら、同じ追記で確定する。B8）。
/// @term 確定方式 | 週を確定する方法。手動（進行役が確定する）か、自動（4 役割の入力がそろったら、同じ追記で確定する）。進行中・一時停止中に変えられる | ドメインモデル ユビキタス言語
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CommitMode {
    #[default]
    Manual,
    Auto,
}

/// ゲーム設定。B1 はキット準拠（初期条件・遅延・費用方針は [`KitPreset`] の値）だけを作る。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GameSettings {
    pub final_week: Week,
    pub demand: DemandSeries,
    pub cost_policy: CostPolicy,
    /// 初期在庫・遅延・公開範囲（キット準拠は [`Conditions::kit`]）。
    pub conditions: Conditions,
    pub commit_mode: CommitMode,
}

impl GameSettings {
    /// キット準拠の設定を、入力の形（最終週 1〜50、需要系列の各週 0〜1000 で長さは最終週以上）を検証して作る。
    /// 誤りは項目ごとにすべて集める（最終週の誤りがあっても、需要系列の各週の誤りも返す）。AC1.1.2。
    ///
    /// # Errors
    /// 最終週・需要系列の誤りのすべて。
    pub fn kit(
        final_week: i64,
        demand: &[i64],
        commit_mode: CommitMode,
    ) -> Result<Self, Vec<ValidationError>> {
        let week = Week::of(final_week);
        let series = DemandSeries::of(demand, week.as_ref().map_or(Week::FIRST, |w| *w));
        match (week, series) {
            (Ok(final_week), Ok(demand)) => Ok(GameSettings {
                final_week,
                demand,
                cost_policy: KitPreset::cost_policy(),
                conditions: Conditions::kit(),
                commit_mode,
            }),
            (week, series) => Err(week
                .err()
                .into_iter()
                .chain(series.err().into_iter().flatten())
                .collect()),
        }
    }

    /// カスタム条件つきの設定。最終週・需要系列と条件の誤りを、項目ごとにすべて集めて返す。
    ///
    /// # Errors
    /// 最終週・需要系列・条件の誤りのすべて。
    pub fn custom(
        final_week: i64,
        demand: &[i64],
        commit_mode: CommitMode,
        input: &ConditionsInput,
    ) -> Result<Self, Vec<ValidationError>> {
        let base = GameSettings::kit(final_week, demand, commit_mode);
        let conditions = Conditions::of(input);
        match (base, conditions) {
            (Ok(base), Ok((conditions, cost_policy))) => Ok(GameSettings {
                cost_policy,
                conditions,
                ..base
            }),
            (base, conditions) => Err(base
                .err()
                .into_iter()
                .flatten()
                .chain(conditions.err().into_iter().flatten())
                .collect()),
        }
    }

    /// キットの値から変えた項目。
    #[must_use]
    pub fn changed_fields(&self) -> Vec<SettingsField> {
        self.conditions.changed_fields(&self.cost_policy)
    }

    /// 設定の種別。キットの値と同じなら `Kit`（最終週と需要系列は判定に含めない）。
    #[must_use]
    pub fn kind(&self) -> SettingsKind {
        if self.changed_fields().is_empty() {
            SettingsKind::Kit
        } else {
            SettingsKind::Custom
        }
    }

    /// 第 1 週の開始時の、役割別の状態。
    #[must_use]
    pub fn initial_states(&self) -> RoleMap<crate::simulate::RoleState> {
        KitPreset::initial_states_with(&self.demand, &self.conditions)
    }

    /// 週次計算に渡す最小の設定。
    #[must_use]
    pub fn simulation(&self) -> SimulationSettings {
        SimulationSettings {
            final_week: self.final_week,
            demand: self.demand.clone(),
            cost_policy: self.cost_policy,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GameData {
    pub game_id: GameId,
    pub settings: GameSettings,
    /// 参加者と、割り当て済みの役割（未割り当ては `None`）。
    pub participants: BTreeMap<ParticipantId, Option<Role>>,
    /// 失効した資格の参加者（再発行で外れる）。
    pub revoked: BTreeSet<ParticipantId>,
    /// 観察用の招待（失効しても残す）。
    pub invitations: BTreeMap<InvitationId, Invitation>,
    /// 参加した観察者（役割を持たない）。
    pub observers: BTreeSet<ObserverId>,
}

/// 観察用の招待。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Invitation {
    pub expires_at: Instant,
    pub revoked: bool,
}

impl GameData {
    /// 役割ごとの参加者（開始時に、Session へ写しとして渡す）。
    #[must_use]
    pub fn role_assignments(&self) -> RoleMap<BTreeSet<ParticipantId>> {
        RoleMap::of(|role| {
            self.participants
                .iter()
                .filter(|(_, assigned)| **assigned == Some(role))
                .map(|(id, _)| *id)
                .collect()
        })
    }

    /// 参加者の役割を変える。未知の参加者なら `None`（decide が作らない列）。
    fn with_role(mut self, participant_id: ParticipantId, role: Option<Role>) -> Option<Self> {
        let entry = self.participants.get_mut(&participant_id)?;
        *entry = role;
        Some(self)
    }
}

/// 状態は版を持たない。ストリームの版は、永続化の層が `(state, version)` として持つ（設計判断 RD2）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GameState {
    /// ストリームが空。
    NotCreated,
    /// 参加・割り当てを受け付ける。
    Preparing(GameData),
    /// 設定と割り当てを固定。
    Started(GameData),
}

impl GameState {
    /// 作成済み（準備中・開始済み）のデータ。
    #[must_use]
    pub const fn data(&self) -> Option<&GameData> {
        match self {
            GameState::NotCreated => None,
            GameState::Preparing(data) | GameState::Started(data) => Some(data),
        }
    }

    fn preparing_data(&self) -> Result<&GameData, GameError> {
        match self {
            GameState::Preparing(data) => Ok(data),
            GameState::NotCreated | GameState::Started(_) => Err(GameError::NotPreparing),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GameCommand {
    CreateGame {
        actor: Actor,
        at: Instant,
        game_id: GameId,
        join_code: JoinCode,
        settings: GameSettings,
        retention_days: RetentionDays,
        facilitator_credential_expires_at: Instant,
    },
    /// 表示名は周辺ストアへ書くための値で、イベントには写さない（NF-S14）。
    JoinGame {
        actor: Actor,
        at: Instant,
        participant_id: ParticipantId,
        display_name: DisplayName,
        credential_expires_at: Instant,
    },
    AssignRole {
        actor: Actor,
        at: Instant,
        participant_id: ParticipantId,
        role: Role,
    },
    /// 参加者の資格の失効（進行役だけ。準備中・開始後の両方）。
    RevokeCredential {
        actor: Actor,
        at: Instant,
        participant_id: ParticipantId,
    },
    /// 観察用の招待の発行（進行役だけ。準備中・開始後の両方）。
    InviteObserver {
        actor: Actor,
        at: Instant,
        invitation_id: InvitationId,
        expires_at: Instant,
    },
    /// 観察用の招待の失効（進行役だけ）。すでに参加した観察者は、そのまま続けられる。
    RevokeObserverInvitation {
        actor: Actor,
        at: Instant,
        invitation_id: InvitationId,
    },
    /// 観察者としての参加（招待コードが認可。境界が招待を引いて渡す）。
    JoinAsObserver {
        at: Instant,
        observer_id: ObserverId,
        invitation_id: InvitationId,
    },
    /// 失効した参加者の資格の再発行（進行役だけ。準備中・開始後の両方）。
    ReissueCredential {
        actor: Actor,
        at: Instant,
        participant_id: ParticipantId,
        credential_expires_at: Instant,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GameEvent {
    /// @event EV-G01 | CreateGame。ストリームが空
    GameCreated {
        game_id: GameId,
        join_code: JoinCode,
        settings: GameSettings,
        retention_days: RetentionDays,
        facilitator_credential_expires_at: Instant,
    },
    /// @event EV-G02 | JoinGame。準備中
    ParticipantJoined {
        participant_id: ParticipantId,
        credential_expires_at: Instant,
    },
    /// @event EV-G03 | AssignRole。進行役、役割が変わる（準備中。開始後は入れ替えの新担当者）
    RoleAssigned {
        participant_id: ParticipantId,
        role: Role,
    },
    /// @event EV-G04 | AssignRole による付け替え（解除の側）。単独の UnassignRole は未実装
    RoleUnassigned {
        participant_id: ParticipantId,
        role: Role,
    },
    /// @event EV-G11 | StartGame。進行役、準備中、各役割に 1 人以上
    GameStarted { game_id: GameId },
    /// 開始後の役割の入れ替え。役割の担当者全員が外れ（資格は失効）、新しい担当者が引き継ぐ。
    /// @event EV-G12 | AssignRole（開始後の入れ替え）。進行役、旧担当者ごとに 1 件
    /// @term 役割の入れ替え | 開始後に、進行役が役割の担当者を別の参加者に替えること。旧担当者の資格は同じ追記で失効し、入力済みの値と週は変わらない | ドメインモデル 役割の入れ替え、ADR-015
    ParticipantReplaced {
        participant_id: ParticipantId,
        role: Role,
        /// 外れた旧担当者（昇順）。
        replaced: Vec<ParticipantId>,
    },
    /// @event EV-G05 | InviteObserver。進行役。準備中と開始後
    /// @term 観察用の招待 | 進行役が発行する、観察者を招くためのコード。参加コードとは別の値で、失効または期限切れの招待では新しく参加できない | AC1.3.1〜1.3.4、BR-17
    ObserverInvited {
        invitation_id: InvitationId,
        expires_at: Instant,
    },
    /// @event EV-G06 | RevokeObserverInvitation。進行役、失効していない招待（期限切れでも可）
    ObserverInvitationRevoked { invitation_id: InvitationId },
    /// @event EV-G07 | JoinAsObserver。有効で期限内の招待（準備中と開始後）
    ObserverJoined {
        observer_id: ObserverId,
        invitation_id: InvitationId,
    },
    /// @event EV-G08 | RevokeCredential。進行役、失効していない参加者の資格（期限切れでも可）
    /// @term 資格の失効 | 進行役が、漏れた参加者の資格を使えなくすること。失効した資格での要求は、以前に成功したものの再送でも拒否する | AC3.2.5、ADR-004
    CredentialRevoked { participant_id: ParticipantId },
    /// @event EV-G09 | ReissueCredential。進行役、失効した参加者の資格
    CredentialReissued {
        participant_id: ParticipantId,
        credential_expires_at: Instant,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GameError {
    AlreadyCreated,
    /// 準備中でない（未作成、または開始済み）。
    NotPreparing,
    Forbidden(&'static str),
    ParticipantNotFound(ParticipantId),
    /// 開始の条件（4 役割のそれぞれに 1 人以上）を満たさない。不足している役割を上流から下流の順に示す（AC1.2.3）。
    StartConditionNotMet(Vec<Role>),
    /// すでに失効している資格の失効。
    CredentialAlreadyRevoked(ParticipantId),
    /// 失効していない資格の再発行（有効な資格は置き換えない）。
    CredentialNotRevoked(ParticipantId),
    /// 観察用の招待が、不明・失効・期限切れ（区別しない）。
    InvitationInvalid,
    /// このゲームに無い招待。
    InvitationNotFound(InvitationId),
    /// すでに失効している招待の失効。
    InvitationAlreadyRevoked(InvitationId),
}

impl GameError {
    /// 安定した `code`（小文字のドット区切り `<領域>.<名前>`）。API の契約なので、一度決めたら変えない。
    /// 列挙子を足したときに付け忘れがコンパイルエラーになるよう、`match` を網羅で書く。
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            GameError::AlreadyCreated => "game.already_created",
            GameError::NotPreparing => "game.not_preparing",
            GameError::Forbidden(_) => "game.forbidden",
            GameError::ParticipantNotFound(_) => "game.participant_not_found",
            GameError::StartConditionNotMet(_) => "game.start_condition_not_met",
            GameError::CredentialAlreadyRevoked(_) => "game.credential_already_revoked",
            GameError::CredentialNotRevoked(_) => "game.credential_not_revoked",
            GameError::InvitationInvalid => "game.invitation_invalid",
            GameError::InvitationNotFound(_) => "game.invitation_not_found",
            GameError::InvitationAlreadyRevoked(_) => "game.credential_already_revoked",
        }
    }

    #[must_use]
    pub const fn category(&self) -> ErrorCategory {
        match self {
            GameError::AlreadyCreated
            | GameError::NotPreparing
            | GameError::CredentialAlreadyRevoked(_)
            | GameError::CredentialNotRevoked(_)
            | GameError::InvitationAlreadyRevoked(_) => ErrorCategory::InvalidState,
            GameError::Forbidden(_) | GameError::InvitationInvalid => ErrorCategory::Forbidden,
            GameError::ParticipantNotFound(_) | GameError::InvitationNotFound(_) => {
                ErrorCategory::NotFound
            }
            GameError::StartConditionNotMet(_) => ErrorCategory::RuleViolation,
        }
    }
}

/// 準備中の割り当て。同じ役割への再割り当ては変化なし（履歴に足さない。D9）、別の役割へは付け替え（2 イベント）。
fn decide_assign(
    state: &GameState,
    actor: &Actor,
    participant_id: ParticipantId,
    role: Role,
) -> Result<Vec<GameEvent>, GameError> {
    let data = state.preparing_data()?;
    if !actor.is_facilitator_of(data.game_id) {
        return Err(GameError::Forbidden("割り当ては進行役だけができる"));
    }
    let previous = data
        .participants
        .get(&participant_id)
        .ok_or(GameError::ParticipantNotFound(participant_id))?;
    Ok(match previous {
        Some(current) if *current == role => Vec::new(),
        None => vec![GameEvent::RoleAssigned {
            participant_id,
            role,
        }],
        Some(current) => vec![
            GameEvent::RoleUnassigned {
                participant_id,
                role: *current,
            },
            GameEvent::RoleAssigned {
                participant_id,
                role,
            },
        ],
    })
}

/// 資格の失効・再発行。進行役だけ。準備中・開始後の両方で受け付ける。
fn decide_credential(
    state: &GameState,
    actor: &Actor,
    participant_id: ParticipantId,
    reissue: Option<Instant>,
) -> Result<Vec<GameEvent>, GameError> {
    let data = state.data().ok_or(GameError::NotPreparing)?;
    if !actor.is_facilitator_of(data.game_id) {
        return Err(GameError::Forbidden(
            "資格の失効・再発行は進行役だけができる",
        ));
    }
    if !data.participants.contains_key(&participant_id) {
        return Err(GameError::ParticipantNotFound(participant_id));
    }
    let revoked = data.revoked.contains(&participant_id);
    match reissue {
        None if revoked => Err(GameError::CredentialAlreadyRevoked(participant_id)),
        None => Ok(vec![GameEvent::CredentialRevoked { participant_id }]),
        Some(_) if !revoked => Err(GameError::CredentialNotRevoked(participant_id)),
        Some(credential_expires_at) => Ok(vec![GameEvent::CredentialReissued {
            participant_id,
            credential_expires_at,
        }]),
    }
}

/// 観察用の招待の発行。進行役だけ。準備中・開始後の両方。
fn invite_events(
    state: &GameState,
    actor: &Actor,
    invitation_id: InvitationId,
    expires_at: Instant,
) -> Result<Vec<GameEvent>, GameError> {
    let data = state.data().ok_or(GameError::NotPreparing)?;
    if !actor.is_facilitator_of(data.game_id) {
        return Err(GameError::Forbidden("観察用の招待は進行役だけが発行できる"));
    }
    Ok(vec![GameEvent::ObserverInvited {
        invitation_id,
        expires_at,
    }])
}

/// 観察用の招待の失効。進行役だけ。すでに参加した観察者は、そのまま続けられる。
fn revoke_invitation_events(
    state: &GameState,
    actor: &Actor,
    invitation_id: InvitationId,
) -> Result<Vec<GameEvent>, GameError> {
    let data = state.data().ok_or(GameError::NotPreparing)?;
    if !actor.is_facilitator_of(data.game_id) {
        return Err(GameError::Forbidden(
            "観察用の招待の失効は進行役だけができる",
        ));
    }
    match data.invitations.get(&invitation_id) {
        None => Err(GameError::InvitationNotFound(invitation_id)),
        Some(invitation) if invitation.revoked => {
            Err(GameError::InvitationAlreadyRevoked(invitation_id))
        }
        Some(_) => Ok(vec![GameEvent::ObserverInvitationRevoked { invitation_id }]),
    }
}

/// 観察者の参加。有効な招待（存在・失効なし・期限内）だけ。無効な理由は区別しない。
fn observer_join_events(
    state: &GameState,
    at: Instant,
    observer_id: ObserverId,
    invitation_id: InvitationId,
) -> Result<Vec<GameEvent>, GameError> {
    let data = state.data().ok_or(GameError::NotPreparing)?;
    match data.invitations.get(&invitation_id) {
        Some(invitation) if !invitation.revoked && invitation.expires_at > at => {
            Ok(vec![GameEvent::ObserverJoined {
                observer_id,
                invitation_id,
            }])
        }
        Some(_) | None => Err(GameError::InvitationInvalid),
    }
}

/// 作成・参加・役割の割り当ての規則は、すべてここに集まる（`evolve` は事実を採用するだけで、規則を持たない）。
/// @landmark ddd 戦術的設計 | 準備の集約の規則。進行と同じ形（状態とコマンドから、事実か誤りを返す）で、コンテキストごとに規則の置き場が 1 つに決まる
///
/// # Errors
/// 規則に反するとき、`GameError`。
pub fn decide_game(state: &GameState, command: &GameCommand) -> Result<Vec<GameEvent>, GameError> {
    match command {
        GameCommand::CreateGame {
            actor,
            game_id,
            join_code,
            settings,
            retention_days,
            facilitator_credential_expires_at,
            ..
        } => {
            if !matches!(state, GameState::NotCreated) {
                return Err(GameError::AlreadyCreated);
            }
            if *actor != Actor::Anonymous {
                return Err(GameError::Forbidden("作成は匿名の操作者だけができる"));
            }
            Ok(vec![GameEvent::GameCreated {
                game_id: *game_id,
                join_code: join_code.clone(),
                settings: settings.clone(),
                retention_days: *retention_days,
                facilitator_credential_expires_at: *facilitator_credential_expires_at,
            }])
        }
        GameCommand::JoinGame {
            participant_id,
            credential_expires_at,
            ..
        } => {
            let data = state.preparing_data()?;
            // 同じ参加者 ID の再参加は変化なし（履歴に足さない）。evolve が採用しないイベントを作らない。
            if data.participants.contains_key(participant_id) {
                return Ok(Vec::new());
            }
            Ok(vec![GameEvent::ParticipantJoined {
                participant_id: *participant_id,
                credential_expires_at: *credential_expires_at,
            }])
        }
        GameCommand::AssignRole {
            actor,
            participant_id,
            role,
            ..
        } => decide_assign(state, actor, *participant_id, *role),
        GameCommand::InviteObserver {
            actor,
            invitation_id,
            expires_at,
            ..
        } => invite_events(state, actor, *invitation_id, *expires_at),
        GameCommand::RevokeObserverInvitation {
            actor,
            invitation_id,
            ..
        } => revoke_invitation_events(state, actor, *invitation_id),
        GameCommand::JoinAsObserver {
            at,
            observer_id,
            invitation_id,
        } => observer_join_events(state, *at, *observer_id, *invitation_id),
        GameCommand::RevokeCredential {
            actor,
            participant_id,
            ..
        } => decide_credential(state, actor, *participant_id, None),
        GameCommand::ReissueCredential {
            actor,
            participant_id,
            credential_expires_at,
            ..
        } => decide_credential(state, actor, *participant_id, Some(*credential_expires_at)),
    }
}

/// 準備中のときだけデータを更新する。decide が作らない列（更新できない）は `Ignored`。
fn update_preparing(
    state: GameState,
    update: impl FnOnce(GameData) -> Option<GameData>,
) -> Evolution<GameState> {
    match state {
        GameState::Preparing(data) => match update(data.clone()) {
            Some(next) => Evolution::Applied(GameState::Preparing(next)),
            None => Evolution::Ignored(GameState::Preparing(data)),
        },
        other @ (GameState::NotCreated | GameState::Started(_)) => Evolution::Ignored(other),
    }
}

/// 作成済み（準備中・開始済み）のときにデータを更新する。更新できない列は `Ignored`。
fn update_created(
    state: GameState,
    update: impl FnOnce(GameData) -> Option<GameData>,
) -> Evolution<GameState> {
    match state {
        GameState::Preparing(data) => match update(data.clone()) {
            Some(next) => Evolution::Applied(GameState::Preparing(next)),
            None => Evolution::Ignored(GameState::Preparing(data)),
        },
        GameState::Started(data) => match update(data.clone()) {
            Some(next) => Evolution::Applied(GameState::Started(next)),
            None => Evolution::Ignored(GameState::Started(data)),
        },
        GameState::NotCreated => Evolution::Ignored(GameState::NotCreated),
    }
}

/// イベントを状態へ畳み込む。全域（`panic` しない）。
/// decide が作らない列は、状態を変えずに `Ignored` で返す（検知は再生側）。
#[must_use]
pub fn evolve_game(state: GameState, event: &GameEvent) -> Evolution<GameState> {
    match event {
        GameEvent::GameCreated {
            game_id, settings, ..
        } => match state {
            GameState::NotCreated => Evolution::Applied(GameState::Preparing(GameData {
                game_id: *game_id,
                settings: settings.clone(),
                participants: BTreeMap::new(),
                revoked: BTreeSet::new(),
                invitations: BTreeMap::new(),
                observers: BTreeSet::new(),
            })),
            other @ (GameState::Preparing(_) | GameState::Started(_)) => Evolution::Ignored(other),
        },
        GameEvent::ParticipantJoined { participant_id, .. } => {
            update_preparing(state, |mut data| {
                if data.participants.contains_key(participant_id) {
                    None
                } else {
                    data.participants.insert(*participant_id, None);
                    Some(data)
                }
            })
        }
        GameEvent::RoleAssigned {
            participant_id,
            role,
        } => update_preparing(state, |data| data.with_role(*participant_id, Some(*role))),
        GameEvent::RoleUnassigned { participant_id, .. } => {
            update_preparing(state, |data| data.with_role(*participant_id, None))
        }
        GameEvent::ParticipantReplaced {
            participant_id,
            role,
            replaced,
        } => match state {
            GameState::Started(mut data) => {
                let valid = data.participants.get(participant_id) == Some(&None)
                    && !replaced.is_empty()
                    && replaced
                        .iter()
                        .all(|r| data.participants.get(r) == Some(&Some(*role)));
                if valid {
                    data.participants.insert(*participant_id, Some(*role));
                    for old in replaced {
                        data.participants.insert(*old, None);
                        data.revoked.insert(*old);
                    }
                    Evolution::Applied(GameState::Started(data))
                } else {
                    Evolution::Ignored(GameState::Started(data))
                }
            }
            other @ (GameState::NotCreated | GameState::Preparing(_)) => Evolution::Ignored(other),
        },
        GameEvent::ObserverInvited {
            invitation_id,
            expires_at,
        } => update_created(state, |mut data| {
            let fresh = !data.invitations.contains_key(invitation_id);
            data.invitations.insert(
                *invitation_id,
                Invitation {
                    expires_at: *expires_at,
                    revoked: false,
                },
            );
            fresh.then_some(data)
        }),
        GameEvent::ObserverInvitationRevoked { invitation_id } => {
            update_created(state, |mut data| {
                let invitation = data
                    .invitations
                    .get_mut(invitation_id)
                    .filter(|i| !i.revoked)?;
                invitation.revoked = true;
                Some(data)
            })
        }
        GameEvent::ObserverJoined {
            observer_id,
            invitation_id,
        } => update_created(state, |mut data| {
            (data.invitations.contains_key(invitation_id) && data.observers.insert(*observer_id))
                .then_some(data)
        }),
        GameEvent::CredentialRevoked { participant_id } => update_created(state, |mut data| {
            if data.participants.contains_key(participant_id)
                && data.revoked.insert(*participant_id)
            {
                Some(data)
            } else {
                None
            }
        }),
        GameEvent::CredentialReissued { participant_id, .. } => {
            update_created(state, |mut data| {
                if data.revoked.remove(participant_id) {
                    Some(data)
                } else {
                    None
                }
            })
        }
        GameEvent::GameStarted { .. } => match state {
            GameState::Preparing(data) => Evolution::Applied(GameState::Started(data)),
            other @ (GameState::NotCreated | GameState::Started(_)) => Evolution::Ignored(other),
        },
    }
}

/// イベント列を状態へ畳み込み、`Ignored` だった（decide が作らない列の）イベントの位置を返す。
#[must_use]
pub fn replay_game(events: &[GameEvent]) -> (GameState, Vec<usize>) {
    events.iter().enumerate().fold(
        (GameState::NotCreated, Vec::new()),
        |(state, mut ignored), (index, event)| {
            let next = evolve_game(state, event);
            if next.is_ignored() {
                ignored.push(index);
            }
            (next.into_state(), ignored)
        },
    )
}
