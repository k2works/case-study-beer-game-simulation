//! 問い合わせの結果（投影から読んだ行）。呼び出した人ごとの開示の規則は、HTTP のアダプター（応答の組み立て）が掛ける。

use beergame_domain::{GameId, ParticipantId, Role};

/// 役割別の現在の状況（`role_current_states` と `current_decisions`）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoleSnapshot {
    pub role: Role,
    pub inventory: i64,
    pub backlog: i64,
    pub arrivals: i64,
    pub orders: i64,
    /// 当週の入力値（未入力は `None`）。
    pub decision: Option<i64>,
    pub decision_version: i64,
    /// 当週の入力を最後に保存した人（未入力は `None`）。
    pub editor: Option<EditorSnapshot>,
    /// 当週の入力の保存の時刻（エポックのミリ秒。未入力は `None`）。
    pub saved_at_millis: Option<i64>,
}

/// 入力を保存した人。表示名は個人情報（周辺ストア）で、同じ役割の共同担当と進行役にだけ示す。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditorSnapshot {
    /// 進行役の代理入力か。
    pub is_proxy: bool,
    /// 参加者の ID（代理入力なら `None`）。
    pub participant_id: Option<ParticipantId>,
    pub display_name: Option<String>,
}

/// 役割の担当者（共同担当を含む）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoHolderRow {
    pub role: Role,
    pub participant_id: ParticipantId,
    pub display_name: Option<String>,
}

/// 確定した週の、役割別の結果（`week_role_results`）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResultRow {
    pub role: Role,
    pub week: i64,
    pub orders: i64,
    pub order: i64,
    pub inventory: i64,
    pub backlog: i64,
    pub shipment: i64,
    pub cost: i64,
    pub cumulative_cost: i64,
}

/// 進行（session）の状態。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionSnapshot {
    pub game_id: GameId,
    /// `ACTIVE`・`ENDED`。
    pub status: String,
    pub week: i64,
    pub submitted_role_count: i64,
    pub final_week: i64,
    pub roles: Vec<RoleSnapshot>,
    pub results: Vec<ResultRow>,
    /// 役割ごとの担当者（共同担当を含む）。
    pub co_holders: Vec<CoHolderRow>,
    pub game_version: u64,
    pub session_version: u64,
}

/// ロビーの参加者（`lobby_participants` と、周辺ストアの表示名）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LobbyParticipantRow {
    pub participant_id: ParticipantId,
    pub role: Option<Role>,
    /// 表示名（周辺ストアに無ければ `None`）。進行役のロビーにだけ使う。
    pub display_name: Option<String>,
}

/// ゲーム（準備・進行）の状態。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GameSnapshot {
    pub game_id: GameId,
    /// `PREPARING`・`STARTED`・`ENDED`。
    pub status: String,
    pub join_code: String,
    pub final_week: i64,
    pub commit_mode: String,
    /// `KIT`・`CUSTOM`。
    pub settings_kind: String,
    /// キットの値から変えた項目（`INITIAL_INVENTORY` など）。
    pub changed_settings: Vec<String>,
    pub participants: Vec<LobbyParticipantRow>,
    /// 観察用の招待（コードの値は含まない）。
    pub invitations: Vec<InvitationRow>,
    /// 参加した観察者。
    pub observers: Vec<ObserverRow>,
    pub game_version: u64,
    /// 開始前は `None`。
    pub session_version: Option<u64>,
}

/// 観察用の招待（ロビー用）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvitationRow {
    pub invitation_id: u128,
    pub expires_at_millis: i64,
    pub revoked: bool,
    pub created_at_millis: i64,
}

/// 参加した観察者（ロビー用）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObserverRow {
    pub observer_id: u128,
    pub display_name: Option<String>,
    pub joined_at_millis: i64,
}

/// 確定した 1 週のチーム合計（観察用）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TeamWeekRow {
    pub week: i64,
    pub ordered: i64,
    pub inventory: i64,
    pub backlog: i64,
    pub contributors: i64,
}

/// 観察の内容の元（`game_overview`・`session_overview`・`week_team_totals` と、公開範囲だけ）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservationSnapshot {
    pub game_id: GameId,
    pub status: String,
    pub final_week: i64,
    /// 開始後だけ。
    pub session: Option<ObservedSession>,
    /// `TEAM_TOTAL`・`NONE`。
    pub disclosure: String,
    pub weeks: Vec<TeamWeekRow>,
    pub game_version: u64,
    pub session_version: Option<u64>,
}

/// 開始後の、進行の外形（役割別の値は含まない）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedSession {
    pub status: String,
    pub week: i64,
    pub submitted_role_count: i64,
}
