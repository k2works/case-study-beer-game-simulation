//! 同期投影。イベントから、投影の表への書き込み（SQL と束縛値）を導く**純粋な関数**。実行は、追記と同じトランザクション（`PgEventStore`）。
//! 設計: architecture-backend の「投影は追記の後に更新する（同じトランザクション）」。
//! 簡略化: 設計の `Projection(Event -> List<RowChange>)` の `RowChange` は、SQL の文と束縛値の列で表した（表の型づけは、投影の表が増える B5 以降に見直す）。

use beergame_domain::{Editor, GameEvent, Pipeline, Role, RoleMap, RoleState, SessionEvent};
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

fn pipeline_json(p: &Pipeline) -> Value {
    json!(p.0.iter().map(|u| u.get()).collect::<Vec<_>>())
}

fn state_upsert(game: Uuid, role: Role, state: &RoleState, as_of_week: Bind) -> Statement {
    st(
        "INSERT INTO role_current_states (game_id, role, inventory, backlog, order_pipeline, shipment_pipeline, \
         production_pipeline, cumulative_cost_minor, arrivals, orders, as_of_week) \
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10) \
         ON CONFLICT (game_id, role) DO UPDATE SET inventory = EXCLUDED.inventory, backlog = EXCLUDED.backlog, \
         order_pipeline = EXCLUDED.order_pipeline, shipment_pipeline = EXCLUDED.shipment_pipeline, \
         cumulative_cost_minor = EXCLUDED.cumulative_cost_minor, arrivals = EXCLUDED.arrivals, \
         orders = EXCLUDED.orders, as_of_week = EXCLUDED.as_of_week",
        vec![
            Bind::Uuid(game),
            Bind::Text(role_name(role).to_owned()),
            Bind::Int(i64::from(state.inventory.get())),
            Bind::Int(i64::from(state.backlog.get())),
            Bind::Json(pipeline_json(&state.order_pipeline)),
            Bind::Json(pipeline_json(&state.delivery_pipeline)),
            Bind::Int(state.cumulative_cost.minor()),
            Bind::Int(i64::from(state.arrivals.get())),
            Bind::Int(i64::from(state.orders.get())),
            as_of_week,
        ],
    )
}

fn states_statements(game: Uuid, states: &RoleMap<RoleState>, as_of_week: &Bind) -> Vec<Statement> {
    Role::ALL
        .into_iter()
        .map(|role| state_upsert(game, role, states.get(role), as_of_week.clone()))
        .collect()
}

fn editor_parts(editor: &Editor) -> (&'static str, u128) {
    match editor {
        Editor::ByParticipant(p) => ("PARTICIPANT", p.get()),
        Editor::ByFacilitator(g) => ("FACILITATOR", g.get()),
    }
}

/// `session` ストリームのイベントが書く投影（`session_overview`・`role_current_states`・`current_decisions`・`week_commits`・`week_role_results`）。
/// `week_team_totals`（観察者向けのチーム合計）は B9 まで書かない。
#[must_use]
pub fn session_statements(game: Uuid, event: &SessionEvent) -> Vec<Statement> {
    match event {
        SessionEvent::SessionStarted { initial_states, .. } => {
            let mut statements = vec![st(
                "INSERT INTO session_overview (game_id, status, week, submitted_role_count, started_at) \
                 VALUES ($1, 'ACTIVE', 1, 0, now())",
                vec![Bind::Uuid(game)],
            )];
            statements.extend(states_statements(game, initial_states, &Bind::Int(1)));
            statements
        }
        SessionEvent::DecisionSaved {
            week,
            role,
            quantity,
            decision_version,
            editor,
            submitted_role_count,
        } => {
            let (kind, who) = editor_parts(editor);
            vec![
                st(
                    "INSERT INTO current_decisions (game_id, role, week, quantity, decision_version, editor_kind, editor_id, updated_at) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, now()) \
                     ON CONFLICT (game_id, role) DO UPDATE SET week = EXCLUDED.week, quantity = EXCLUDED.quantity, \
                     decision_version = EXCLUDED.decision_version, editor_kind = EXCLUDED.editor_kind, \
                     editor_id = EXCLUDED.editor_id, updated_at = EXCLUDED.updated_at",
                    vec![
                        Bind::Uuid(game),
                        Bind::Text(role_name(*role).to_owned()),
                        Bind::Int(i64::from(week.get())),
                        Bind::Int(i64::from(quantity.get())),
                        Bind::Int(i64::from(decision_version.get())),
                        Bind::Text(kind.to_owned()),
                        pid(who),
                    ],
                ),
                st(
                    "UPDATE session_overview SET submitted_role_count = $2 WHERE game_id = $1",
                    vec![
                        Bind::Uuid(game),
                        Bind::Int(i64::try_from(*submitted_role_count).unwrap_or(0)),
                    ],
                ),
            ]
        }
        SessionEvent::WeekCommitted {
            week,
            commit_kind: _,
            results,
            next_states,
            contributors,
            ..
        } => {
            let mut statements = vec![st(
                "INSERT INTO week_commits (game_id, week, commit_kind, contributors, stream_version, committed_at) \
                 VALUES ($1, $2, 'MANUAL', $3, (SELECT max(stream_version) FROM events WHERE game_id = $1 AND stream_type = 'SESSION'), now())",
                vec![
                    Bind::Uuid(game),
                    Bind::Int(i64::from(week.get())),
                    Bind::Int(i64::try_from(*contributors).unwrap_or(0)),
                ],
            )];
            for role in Role::ALL {
                let r = results.get(role);
                statements.push(st(
                    "INSERT INTO week_role_results (game_id, week, role, demand, shipped, ordered, ending_inventory, \
                     ending_backlog, weekly_cost_minor, cumulative_cost_minor) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
                    vec![
                        Bind::Uuid(game),
                        Bind::Int(i64::from(week.get())),
                        Bind::Text(role_name(role).to_owned()),
                        Bind::Int(i64::from(r.orders.get())),
                        Bind::Int(i64::from(r.shipped.get())),
                        Bind::Int(i64::from(r.ordered.get())),
                        Bind::Int(i64::from(r.ending_inventory.get())),
                        Bind::Int(i64::from(r.ending_backlog.get())),
                        Bind::Int(r.weekly_cost.minor()),
                        Bind::Int(r.cumulative_cost.minor()),
                    ],
                ));
            }
            // 次週の状態。最終週の確定では、週は進まない（as_of_week は最終週のまま）
            let as_of = Bind::Int(i64::from(week.get()).saturating_add(1));
            statements.extend(states_statements(game, next_states, &as_of));
            statements.push(st(
                "UPDATE role_current_states SET as_of_week = LEAST(as_of_week, \
                 (SELECT final_week FROM game_overview WHERE game_id = $1)) WHERE game_id = $1",
                vec![Bind::Uuid(game)],
            ));
            statements.push(st(
                "DELETE FROM current_decisions WHERE game_id = $1",
                vec![Bind::Uuid(game)],
            ));
            statements.push(st(
                "UPDATE session_overview SET week = LEAST($2, (SELECT final_week FROM game_overview WHERE game_id = $1)), \
                 submitted_role_count = 0 WHERE game_id = $1",
                vec![Bind::Uuid(game), as_of],
            ));
            statements
        }
        SessionEvent::SessionEnded { .. } => vec![
            st(
                "UPDATE session_overview SET status = 'ENDED', ended_at = now() WHERE game_id = $1",
                vec![Bind::Uuid(game)],
            ),
            st(
                "UPDATE game_overview SET status = 'ENDED', ended_at = now() WHERE game_id = $1",
                vec![Bind::Uuid(game)],
            ),
        ],
    }
}
