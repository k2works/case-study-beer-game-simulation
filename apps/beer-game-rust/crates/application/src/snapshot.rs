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
    pub participants: Vec<LobbyParticipantRow>,
    pub game_version: u64,
    /// 開始前は `None`。
    pub session_version: Option<u64>,
}
