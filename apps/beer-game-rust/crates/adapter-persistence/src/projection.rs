//! 同期投影。イベントから、投影の表への書き込み（SQL と束縛値）を導く**純粋な関数**。実行は、追記と同じトランザクション（`PgEventStore`）。
//! 設計: architecture-backend の「投影は追記の後に更新する（同じトランザクション）」。
//! 簡略化: 設計の `Projection(Event -> List<RowChange>)` の `RowChange` は、SQL の文と束縛値の列で表した（表の型づけは、投影の表が増える B5 以降に見直す）。

use beergame_domain::{GameEvent, Role};
use serde_json::{Value, json};
use uuid::Uuid;

/// 束縛する値。
#[derive(Clone, Debug, PartialEq)]
pub enum Bind {
    Uuid(Uuid),
    Text(String),
    Int(i64),
    Json(Value),
    NullText,
}

/// 実行する 1 文。
#[derive(Clone, Debug, PartialEq)]
pub struct Statement {
    pub sql: &'static str,
    pub binds: Vec<Bind>,
}

fn st(sql: &'static str, binds: Vec<Bind>) -> Statement {
    Statement { sql, binds }
}

pub(crate) fn role_name(role: Role) -> &'static str {
    match role {
        Role::Factory => "FACTORY",
        Role::Distributor => "DISTRIBUTOR",
        Role::Wholesaler => "WHOLESALER",
        Role::Retailer => "RETAILER",
    }
}

fn pid(n: u128) -> Bind {
    Bind::Uuid(Uuid::from_u128(n))
}

/// `game` ストリームのイベントが書く投影（`game_overview`・`game_join_codes`・`game_settings`・`lobby_participants`）。
#[must_use]
pub fn game_statements(game: Uuid, event: &GameEvent) -> Vec<Statement> {
    match event {
        GameEvent::GameCreated {
            join_code,
            settings,
            retention_days,
            ..
        } => vec![
            st(
                "INSERT INTO game_overview (game_id, status, final_week, commit_mode, settings_kind, settings_changes, \
                 retention_days, created_at) VALUES ($1, 'PREPARING', $2, $3, 'KIT', '[]'::jsonb, $4, now())",
                vec![
                    Bind::Uuid(game),
                    Bind::Int(i64::from(settings.final_week.get())),
                    Bind::Text(
                        match settings.commit_mode {
                            beergame_domain::CommitMode::Manual => "MANUAL",
                            beergame_domain::CommitMode::Auto => "AUTO",
                        }
                        .to_owned(),
                    ),
                    Bind::Int(i64::from(retention_days.get())),
                ],
            ),
            st(
                "INSERT INTO game_join_codes (game_id, join_code) VALUES ($1, $2)",
                vec![Bind::Uuid(game), Bind::Text(join_code.as_str().to_owned())],
            ),
            st(
                "INSERT INTO game_settings (game_id, demand, holding_cost_minor, backlog_cost_minor) VALUES ($1, $2, $3, $4)",
                vec![
                    Bind::Uuid(game),
                    Bind::Json(json!(settings.demand.to_ints())),
                    Bind::Int(settings.cost_policy.holding.minor()),
                    Bind::Int(settings.cost_policy.backlog.minor()),
                ],
            ),
        ],
        GameEvent::ParticipantJoined { participant_id, .. } => vec![st(
            "INSERT INTO lobby_participants (participant_id, game_id, role, joined_at) VALUES ($1, $2, NULL, now())",
            vec![pid(participant_id.get()), Bind::Uuid(game)],
        )],
        GameEvent::RoleAssigned {
            participant_id,
            role,
        } => vec![st(
            "UPDATE lobby_participants SET role = $2 WHERE participant_id = $1",
            vec![
                pid(participant_id.get()),
                Bind::Text(role_name(*role).to_owned()),
            ],
        )],
        GameEvent::RoleUnassigned { participant_id, .. } => vec![st(
            "UPDATE lobby_participants SET role = NULL WHERE participant_id = $1",
            vec![pid(participant_id.get())],
        )],
        GameEvent::GameStarted { .. } => vec![st(
            "UPDATE game_overview SET status = 'STARTED', started_at = now() WHERE game_id = $1",
            vec![Bind::Uuid(game)],
        )],
    }
}
