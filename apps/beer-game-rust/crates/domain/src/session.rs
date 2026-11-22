//! Session 集約（進行。ストリーム `session`）。B1 の範囲: 開始、入力の保存、手動の確定、最終週での終了。
//! 一時停止・代理入力・共同担当・自動確定・役割の入れ替えは後続の Bolt。

use std::collections::{BTreeMap, BTreeSet};

use crate::foundation::{Actor, ErrorCategory, Evolution};
use crate::game::{CommitMode, GameSettings};
use crate::role::{Role, RoleMap};
use crate::simulate::{RoleState, RoleWeekResult, simulate_week};
use crate::values::{DecisionVersion, GameId, Instant, ParticipantId, Quantity, Week};

/// 保存回数の上限（役割ごと・週ごと。AC2.2.*）。版は値の変化でなく、保存で数える。
pub const SAVE_LIMIT_PER_ROLE_WEEK: u32 = 9;

/// 確定の種類。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitKind {
    Manual,
    /// 4 役割の入力がそろった追記と同じ追記で確定した（自動確定。US2.4）。
    Auto,
}

/// 終了の理由。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndReason {
    FinalWeek,
}

/// 入力した人。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Editor {
    ByParticipant(ParticipantId),
    ByFacilitator(GameId),
}

/// 保存された入力。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecisionEntry {
    pub quantity: Quantity,
    pub version: DecisionVersion,
    pub editor: Editor,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionData {
    pub game_id: GameId,
    pub settings: GameSettings,
    /// 開始時の、役割ごとの参加者の写し。
    pub assignments: RoleMap<BTreeSet<ParticipantId>>,
    pub week: Week,
    pub role_states: RoleMap<RoleState>,
    /// 当週に保存された入力（役割ごと）。
    pub decisions: BTreeMap<Role, DecisionEntry>,
    /// 当週の、役割ごとの意思決定の版（保存のたびに 1 増える）。
    pub decision_versions: RoleMap<DecisionVersion>,
    pub commit_mode: CommitMode,
    /// 一時停止中（入力の保存と週の確定を拒否する。代理入力は受け付ける）。
    pub paused: bool,
}

impl SessionData {
    /// まだ入力がない役割（上流から下流の順）。
    #[must_use]
    pub fn missing_roles(&self) -> Vec<Role> {
        Role::ALL
            .into_iter()
            .filter(|role| !self.decisions.contains_key(role))
            .collect()
    }

    /// 4 役割の入力がそろっていれば、その数量。
    #[must_use]
    pub fn complete_decisions(&self) -> Option<RoleMap<Quantity>> {
        let quantity = |role: Role| self.decisions.get(&role).map(|entry| entry.quantity);
        Some(RoleMap {
            factory: quantity(Role::Factory)?,
            distributor: quantity(Role::Distributor)?,
            wholesaler: quantity(Role::Wholesaler)?,
            retailer: quantity(Role::Retailer)?,
        })
    }

    #[must_use]
    pub fn has_save_capacity(&self, role: Role) -> bool {
        self.decision_versions.get(role).get() < SAVE_LIMIT_PER_ROLE_WEEK
    }

    fn with_decision(mut self, role: Role, saved: DecisionEntry) -> Self {
        let version = saved.version;
        self.decisions.insert(role, saved);
        self.decision_versions = self
            .decision_versions
            .map(|r, v| if r == role { version } else { *v });
        self
    }

    fn after_commit(self, next_states: &RoleMap<RoleState>) -> Self {
        let week = if self.week == self.settings.final_week {
            self.week
        } else {
            self.week.next().unwrap_or(self.week)
        };
        SessionData {
            role_states: next_states.clone(),
            week,
            decisions: BTreeMap::new(),
            decision_versions: RoleMap::all(&DecisionVersion::ZERO),
            ..self
        }
    }
}

/// 状態は版を持たない（ストリームの版は永続化の層が持つ。設計判断 RD2）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionState {
    NotStarted,
    Active(SessionData),
    Ended(SessionData),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionCommand {
    SaveDecision {
        actor: Actor,
        at: Instant,
        role: Role,
        requested_week: Week,
        quantity: Quantity,
        expected_decision_version: DecisionVersion,
    },
    CommitWeek {
        actor: Actor,
        at: Instant,
        requested_week: Week,
        /// 確定の根拠にした、役割ごとの意思決定の版。
        basis: RoleMap<DecisionVersion>,
    },
    /// 確定方式の変更（進行役だけ。進行中でも停止中でも）。自動確定を有効にしたとき、入力がそろっていれば同じ追記で確定する。
    SetCommitMode {
        actor: Actor,
        at: Instant,
        mode: CommitMode,
    },
    /// 一時停止（進行役だけ）。
    PauseSession { actor: Actor, at: Instant },
    /// 再開（進行役だけ）。
    ResumeSession { actor: Actor, at: Instant },
    /// 進行役の代理入力（意思決定の版は要求しない。停止中も受け付ける）。
    SubmitProxyDecision {
        actor: Actor,
        at: Instant,
        role: Role,
        requested_week: Week,
        quantity: Quantity,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionEvent {
    SessionStarted {
        game_id: GameId,
        settings: GameSettings,
        assignments: RoleMap<BTreeSet<ParticipantId>>,
        initial_states: RoleMap<RoleState>,
        commit_mode: CommitMode,
    },
    DecisionSaved {
        week: Week,
        role: Role,
        quantity: Quantity,
        decision_version: DecisionVersion,
        editor: Editor,
        submitted_role_count: usize,
    },
    WeekCommitted {
        week: Week,
        commit_kind: CommitKind,
        decisions: RoleMap<Quantity>,
        results: RoleMap<RoleWeekResult>,
        next_states: RoleMap<RoleState>,
        contributors: usize,
    },
    SessionEnded {
        reason: EndReason,
    },
    SessionPaused,
    SessionResumed,
    /// 確定方式の変更。
    CommitModeChanged {
        mode: CommitMode,
    },
    /// 開始後の役割の入れ替え。役割の担当者が、新しい担当者だけになる。
    RoleReplaced {
        role: Role,
        new_holder: ParticipantId,
    },
    /// 進行役の代理入力（監査のため、`DecisionSaved` とは別の事実として残す）。
    ProxyDecisionSubmitted {
        week: Week,
        role: Role,
        quantity: Quantity,
        decision_version: DecisionVersion,
        operator: GameId,
        submitted_role_count: usize,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionError {
    /// 開始前。
    NotActive,
    AlreadyEnded,
    AlreadyStarted,
    SaveLimitReached,
    /// 一時停止中。
    Paused,
    /// 停止中でないものの再開。
    NotPaused,
    Forbidden(&'static str),
    /// 古い画面からの要求（週がすでに進んでいる）。
    WeekAdvanced {
        requested: Week,
        current: Week,
    },
    /// 同じ役割の別の保存と競合した（意思決定の版が違う）。
    DecisionConflict {
        role: Role,
        latest: Option<DecisionEntry>,
    },
    /// 確定の根拠にした入力が、現在と違う。
    DecisionsChanged {
        week: Week,
        current: BTreeMap<Role, DecisionEntry>,
    },
    /// 4 役割の入力がそろっていない。不足している役割を上流から下流の順に示す。
    IncompleteDecisions {
        missing: Vec<Role>,
    },
}

impl SessionError {
    /// 安定した `code`。API の契約なので、一度決めたら変えない。`match` は網羅で書く。
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            SessionError::NotActive => "session.not_active",
            SessionError::AlreadyEnded => "session.already_ended",
            SessionError::AlreadyStarted => "session.already_started",
            SessionError::SaveLimitReached => "session.save_limit_reached",
            SessionError::Paused => "session.paused",
            SessionError::NotPaused => "session.not_paused",
            SessionError::Forbidden(_) => "session.forbidden",
            SessionError::WeekAdvanced { .. } => "session.week_advanced",
            SessionError::DecisionConflict { .. } => "session.decision_conflict",
            SessionError::DecisionsChanged { .. } => "session.decisions_changed",
            SessionError::IncompleteDecisions { .. } => "session.incomplete_decisions",
        }
    }

    #[must_use]
    pub const fn category(&self) -> ErrorCategory {
        match self {
            SessionError::NotActive
            | SessionError::AlreadyEnded
            | SessionError::AlreadyStarted
            | SessionError::SaveLimitReached
            | SessionError::Paused
            | SessionError::NotPaused => ErrorCategory::InvalidState,
            SessionError::Forbidden(_) => ErrorCategory::Forbidden,
            SessionError::WeekAdvanced { .. }
            | SessionError::DecisionConflict { .. }
            | SessionError::DecisionsChanged { .. } => ErrorCategory::Conflict,
            SessionError::IncompleteDecisions { .. } => ErrorCategory::RuleViolation,
        }
    }
}

impl SessionState {
    /// 進行中のデータ。進行中でなければ、状態に応じた誤り。
    fn active_data(&self) -> Result<&SessionData, SessionError> {
        match self {
            SessionState::Active(data) => Ok(data),
            SessionState::NotStarted => Err(SessionError::NotActive),
            SessionState::Ended(_) => Err(SessionError::AlreadyEnded),
        }
    }
}

/// 入力した人。その役割の参加者だけが入力できる。
fn editor_of(
    actor: &Actor,
    role: Role,
    assignments: &RoleMap<BTreeSet<ParticipantId>>,
) -> Result<Editor, SessionError> {
    match actor {
        Actor::Participant(id) if assignments.get(role).contains(id) => {
            Ok(Editor::ByParticipant(*id))
        }
        Actor::Participant(_) | Actor::Facilitator(_) | Actor::Observer(_) | Actor::Anonymous => {
            Err(SessionError::Forbidden("その役割の参加者だけが入力できる"))
        }
    }
}

fn save_decision_events(
    data: &SessionData,
    actor: &Actor,
    role: Role,
    requested_week: Week,
    quantity: Quantity,
    expected: DecisionVersion,
) -> Result<Vec<SessionEvent>, SessionError> {
    let editor = editor_of(actor, role, &data.assignments)?;
    if data.paused {
        return Err(SessionError::Paused);
    }
    if requested_week != data.week {
        return Err(SessionError::WeekAdvanced {
            requested: requested_week,
            current: data.week,
        });
    }
    let current = *data.decision_versions.get(role);
    if expected != current {
        return Err(SessionError::DecisionConflict {
            role,
            latest: data.decisions.get(&role).cloned(),
        });
    }
    if !data.has_save_capacity(role) {
        return Err(SessionError::SaveLimitReached);
    }
    let submitted = data
        .decisions
        .keys()
        .chain(std::iter::once(&role))
        .collect::<BTreeSet<_>>()
        .len();
    let saved = SessionEvent::DecisionSaved {
        week: data.week,
        role,
        quantity,
        decision_version: current.next(),
        editor,
        submitted_role_count: submitted,
    };
    let after = data.clone().with_decision(
        role,
        DecisionEntry {
            quantity,
            version: current.next(),
            editor,
        },
    );
    Ok(with_auto_commit(&after, saved))
}

/// 保存の結果（`after`）、自動確定が有効で、停止中でなく、4 役割の入力がそろうなら、同じ追記で週を確定する（US2.4）。
fn with_auto_commit(after: &SessionData, saved: SessionEvent) -> Vec<SessionEvent> {
    let mut events = vec![saved];
    events.extend(auto_commit_events(after));
    events
}

/// 自動確定の判定。自動確定が有効で、停止中でなく、4 役割の入力がそろっていれば、確定のイベント。
fn auto_commit_events(data: &SessionData) -> Vec<SessionEvent> {
    if data.commit_mode != CommitMode::Auto || data.paused {
        return Vec::new();
    }
    data.complete_decisions()
        .map(|decisions| week_commit_events(data, decisions, CommitKind::Auto))
        .unwrap_or_default()
}

fn require_facilitator(
    data: &SessionData,
    actor: &Actor,
    message: &'static str,
) -> Result<(), SessionError> {
    if actor.is_facilitator_of(data.game_id) {
        Ok(())
    } else {
        Err(SessionError::Forbidden(message))
    }
}

fn pause_events(data: &SessionData, actor: &Actor) -> Result<Vec<SessionEvent>, SessionError> {
    require_facilitator(data, actor, "一時停止は進行役だけができる")?;
    if data.paused {
        return Err(SessionError::Paused);
    }
    Ok(vec![SessionEvent::SessionPaused])
}

fn resume_events(data: &SessionData, actor: &Actor) -> Result<Vec<SessionEvent>, SessionError> {
    require_facilitator(data, actor, "再開は進行役だけができる")?;
    if !data.paused {
        return Err(SessionError::NotPaused);
    }
    // 再開のとき、停止中にそろっていた入力で、自動確定を判定する（AC2.4.3）
    let resumed = SessionData {
        paused: false,
        ..data.clone()
    };
    let mut events = vec![SessionEvent::SessionResumed];
    events.extend(auto_commit_events(&resumed));
    Ok(events)
}

fn commit_mode_events(
    data: &SessionData,
    actor: &Actor,
    mode: CommitMode,
) -> Result<Vec<SessionEvent>, SessionError> {
    require_facilitator(data, actor, "確定方式の変更は進行役だけができる")?;
    if data.commit_mode == mode {
        return Ok(Vec::new());
    }
    let changed = SessionData {
        commit_mode: mode,
        ..data.clone()
    };
    let mut events = vec![SessionEvent::CommitModeChanged { mode }];
    events.extend(auto_commit_events(&changed));
    Ok(events)
}

fn proxy_events(
    data: &SessionData,
    actor: &Actor,
    role: Role,
    requested_week: Week,
    quantity: Quantity,
) -> Result<Vec<SessionEvent>, SessionError> {
    require_facilitator(data, actor, "代理入力は進行役だけができる")?;
    if requested_week != data.week {
        return Err(SessionError::WeekAdvanced {
            requested: requested_week,
            current: data.week,
        });
    }
    if !data.has_save_capacity(role) {
        return Err(SessionError::SaveLimitReached);
    }
    let submitted = data
        .decisions
        .keys()
        .chain(std::iter::once(&role))
        .collect::<BTreeSet<_>>()
        .len();
    let proxied = SessionEvent::ProxyDecisionSubmitted {
        week: data.week,
        role,
        quantity,
        decision_version: data.decision_versions.get(role).next(),
        operator: data.game_id,
        submitted_role_count: submitted,
    };
    let after = data.clone().with_decision(
        role,
        DecisionEntry {
            quantity,
            version: data.decision_versions.get(role).next(),
            editor: Editor::ByFacilitator(data.game_id),
        },
    );
    Ok(with_auto_commit(&after, proxied))
}

/// 4 役割の入力から、週の確定のイベントを作る。最終週なら `SessionEnded` も返す。
fn week_commit_events(
    data: &SessionData,
    decisions: RoleMap<Quantity>,
    kind: CommitKind,
) -> Vec<SessionEvent> {
    let outcome = simulate_week(
        &data.settings.simulation(),
        data.week,
        &data.role_states,
        &decisions,
    );
    let committed = SessionEvent::WeekCommitted {
        week: data.week,
        commit_kind: kind,
        decisions,
        results: outcome.results,
        next_states: outcome.next_states,
        contributors: Role::ALL.len(),
    };
    if data.week == data.settings.final_week {
        vec![
            committed,
            SessionEvent::SessionEnded {
                reason: EndReason::FinalWeek,
            },
        ]
    } else {
        vec![committed]
    }
}

fn commit_week_events(
    data: &SessionData,
    actor: &Actor,
    requested_week: Week,
    basis: &RoleMap<DecisionVersion>,
) -> Result<Vec<SessionEvent>, SessionError> {
    if !actor.is_facilitator_of(data.game_id) {
        return Err(SessionError::Forbidden("確定は進行役だけができる"));
    }
    if data.paused {
        return Err(SessionError::Paused);
    }
    // 判定順 1: 週が違えば WeekAdvanced
    if requested_week != data.week {
        return Err(SessionError::WeekAdvanced {
            requested: requested_week,
            current: data.week,
        });
    }
    // 判定順 2: 週は同じで、確定の根拠にした入力の版が現在と違えば DecisionsChanged
    if *basis != data.decision_versions {
        return Err(SessionError::DecisionsChanged {
            week: data.week,
            current: data.decisions.clone(),
        });
    }
    let decisions = data
        .complete_decisions()
        .ok_or_else(|| SessionError::IncompleteDecisions {
            missing: data.missing_roles(),
        })?;
    Ok(week_commit_events(data, decisions, CommitKind::Manual))
}

/// 進行の規則のすべてがここに集まる（`evolve` は事実を採用するだけ）。
///
/// # Errors
/// 規則に反するとき、`SessionError`。
pub fn decide_session(
    state: &SessionState,
    command: &SessionCommand,
) -> Result<Vec<SessionEvent>, SessionError> {
    match command {
        SessionCommand::SaveDecision {
            actor,
            role,
            requested_week,
            quantity,
            expected_decision_version,
            ..
        } => save_decision_events(
            state.active_data()?,
            actor,
            *role,
            *requested_week,
            *quantity,
            *expected_decision_version,
        ),
        SessionCommand::CommitWeek {
            actor,
            requested_week,
            basis,
            ..
        } => commit_week_events(state.active_data()?, actor, *requested_week, basis),
        SessionCommand::SetCommitMode { actor, mode, .. } => {
            commit_mode_events(state.active_data()?, actor, *mode)
        }
        SessionCommand::PauseSession { actor, .. } => pause_events(state.active_data()?, actor),
        SessionCommand::ResumeSession { actor, .. } => resume_events(state.active_data()?, actor),
        SessionCommand::SubmitProxyDecision {
            actor,
            role,
            requested_week,
            quantity,
            ..
        } => proxy_events(
            state.active_data()?,
            actor,
            *role,
            *requested_week,
            *quantity,
        ),
    }
}

/// 進行中のときだけデータを更新する。decide が作らない列は `Ignored`。
fn update_active(
    state: SessionState,
    update: impl FnOnce(SessionData) -> SessionData,
) -> Evolution<SessionState> {
    match state {
        SessionState::Active(data) => Evolution::Applied(SessionState::Active(update(data))),
        other @ (SessionState::NotStarted | SessionState::Ended(_)) => Evolution::Ignored(other),
    }
}

/// イベントを状態へ畳み込む。全域。`WeekCommitted` の `next_states` はそのまま採用し、`simulate_week` を呼ばない（D5）。
/// decide が作らない列は、状態を変えずに `Ignored` で返す。
#[must_use]
pub fn evolve_session(state: SessionState, event: &SessionEvent) -> Evolution<SessionState> {
    match event {
        SessionEvent::SessionStarted {
            game_id,
            settings,
            assignments,
            initial_states,
            commit_mode,
        } => match state {
            SessionState::NotStarted => Evolution::Applied(SessionState::Active(SessionData {
                game_id: *game_id,
                settings: settings.clone(),
                assignments: assignments.clone(),
                week: Week::FIRST,
                role_states: initial_states.clone(),
                decisions: BTreeMap::new(),
                decision_versions: RoleMap::all(&DecisionVersion::ZERO),
                commit_mode: *commit_mode,
                paused: false,
            })),
            other @ (SessionState::Active(_) | SessionState::Ended(_)) => Evolution::Ignored(other),
        },
        SessionEvent::DecisionSaved {
            role,
            quantity,
            decision_version,
            editor,
            ..
        } => update_active(state, |data| {
            data.with_decision(
                *role,
                DecisionEntry {
                    quantity: *quantity,
                    version: *decision_version,
                    editor: *editor,
                },
            )
        }),
        SessionEvent::ProxyDecisionSubmitted {
            role,
            quantity,
            decision_version,
            operator,
            ..
        } => update_active(state, |data| {
            data.with_decision(
                *role,
                DecisionEntry {
                    quantity: *quantity,
                    version: *decision_version,
                    editor: Editor::ByFacilitator(*operator),
                },
            )
        }),
        SessionEvent::RoleReplaced { role, new_holder } => update_active(state, |data| {
            let assignments = data.assignments.map(|r, holders| {
                if r == *role {
                    BTreeSet::from([*new_holder])
                } else {
                    holders.clone()
                }
            });
            SessionData {
                assignments,
                ..data
            }
        }),
        SessionEvent::CommitModeChanged { mode } => update_active(state, |data| SessionData {
            commit_mode: *mode,
            ..data
        }),
        SessionEvent::SessionPaused => update_active(state, |data| SessionData {
            paused: true,
            ..data
        }),
        SessionEvent::SessionResumed => update_active(state, |data| SessionData {
            paused: false,
            ..data
        }),
        SessionEvent::WeekCommitted { next_states, .. } => {
            update_active(state, |data| data.after_commit(next_states))
        }
        SessionEvent::SessionEnded { .. } => match state {
            SessionState::Active(data) => Evolution::Applied(SessionState::Ended(data)),
            other @ (SessionState::NotStarted | SessionState::Ended(_)) => {
                Evolution::Ignored(other)
            }
        },
    }
}

/// イベント列を状態へ畳み込み、`Ignored` だったイベントの位置を返す。
#[must_use]
pub fn replay_session(events: &[SessionEvent]) -> (SessionState, Vec<usize>) {
    events.iter().enumerate().fold(
        (SessionState::NotStarted, Vec::new()),
        |(state, mut ignored), (index, event)| {
            let next = evolve_session(state, event);
            if next.is_ignored() {
                ignored.push(index);
            }
            (next.into_state(), ignored)
        },
    )
}
