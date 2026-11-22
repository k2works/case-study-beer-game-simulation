//! 同期投影。イベントから、投影の表への書き込み（SQL と束縛値）を導く**純粋な関数**。実行は、追記と同じトランザクション（`PgEventStore`）。
//! 設計: architecture-backend の「投影は追記の後に更新する（同じトランザクション）」。
//! 簡略化: 設計の `Projection(Event -> List<RowChange>)` の `RowChange` は、SQL の文と束縛値の列で表した（表の型づけは、投影の表が増える B5 以降に見直す）。

use beergame_application::{CredentialKind, PeripheralWrite};
use beergame_domain::{
    CommitKind, Conditions, DecisionVersion, DisclosurePolicy, Editor, GameEvent, Pipeline,
    Quantity, Role, RoleMap, RoleState, SessionEvent, SettingsField, SettingsKind, Week,
};
use serde_json::{Value, json};
use uuid::Uuid;

/// 束縛する値。
#[derive(Clone, Debug, PartialEq)]
pub enum Bind {
    Uuid(Uuid),
    Text(String),
    Int(i64),
    Json(Value),
    Bytes(Vec<u8>),
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
                 retention_days, created_at) VALUES ($1, 'PREPARING', $2, $3, $5, $6, $4, now())",
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
                    Bind::Text(
                        match settings.kind() {
                            SettingsKind::Kit => "KIT",
                            SettingsKind::Custom => "CUSTOM",
                        }
                        .to_owned(),
                    ),
                    Bind::Json(json!(
                        settings
                            .changed_fields()
                            .iter()
                            .map(|f| field_name(*f))
                            .collect::<Vec<_>>()
                    )),
                ],
            ),
            // 保持の方針。起点は暫定で作成時（M5。人の確認が要る）。削除予定日は、起点 + 保持日数
            st(
                "INSERT INTO retention_policies (game_id, retention_days, retention_starts_at, delete_after) \
                 VALUES ($1, $2::integer, now(), now() + make_interval(days => $2::integer))",
                vec![Bind::Uuid(game), Bind::Int(i64::from(retention_days.get()))],
            ),
            st(
                "INSERT INTO game_join_codes (game_id, join_code) VALUES ($1, $2)",
                vec![Bind::Uuid(game), Bind::Text(join_code.as_str().to_owned())],
            ),
            st(
                "INSERT INTO game_settings (game_id, demand, initial_conditions, holding_cost_minor, backlog_cost_minor, \
                 order_delay_weeks, shipment_delay_weeks, production_delay_weeks, disclosure_policy) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                vec![
                    Bind::Uuid(game),
                    Bind::Json(json!(settings.demand.to_ints())),
                    Bind::Json(json!({
                        "initialInventory": role_inventory(&settings.conditions),
                        "initialFlow": settings.conditions.initial_flow.get(),
                    })),
                    Bind::Int(settings.cost_policy.holding.minor()),
                    Bind::Int(settings.cost_policy.backlog.minor()),
                    Bind::Int(i64::from(settings.conditions.order_delay)),
                    Bind::Int(i64::from(settings.conditions.shipment_delay)),
                    Bind::Int(i64::from(settings.conditions.production_delay)),
                    Bind::Text(
                        match settings.conditions.disclosure {
                            DisclosurePolicy::TeamTotal => "TEAM_TOTAL",
                            DisclosurePolicy::None => "NONE",
                        }
                        .to_owned(),
                    ),
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
        GameEvent::ParticipantReplaced {
            participant_id,
            role,
            replaced,
        } => {
            // 旧担当者の行は消さず（履歴・入力者のラベルのため）、役割を外して入れ替えの時刻を書く。新担当者に役割を付ける
            let mut statements: Vec<Statement> = replaced
                .iter()
                .map(|old| {
                    st(
                        "UPDATE lobby_participants SET role = NULL, replaced_at = now() WHERE participant_id = $1",
                        vec![pid(old.get())],
                    )
                })
                .collect();
            statements.push(st(
                "UPDATE lobby_participants SET role = $2 WHERE participant_id = $1",
                vec![
                    pid(participant_id.get()),
                    Bind::Text(role_name(*role).to_owned()),
                ],
            ));
            statements
        }
        GameEvent::ObserverInvited {
            invitation_id,
            expires_at,
        } => vec![st(
            "INSERT INTO lobby_observer_invitations (invitation_id, game_id, expires_at, created_at) \
             VALUES ($1, $2, to_timestamp($3::double precision / 1000), now())",
            vec![
                pid(invitation_id.get()),
                Bind::Uuid(game),
                Bind::Int(expires_at.epoch_millis()),
            ],
        )],
        GameEvent::ObserverInvitationRevoked { invitation_id } => vec![st(
            "UPDATE lobby_observer_invitations SET revoked_at = now() WHERE invitation_id = $1",
            vec![pid(invitation_id.get())],
        )],
        GameEvent::ObserverJoined {
            observer_id,
            invitation_id,
        } => vec![st(
            "INSERT INTO lobby_observers (observer_id, game_id, invitation_id, joined_at) VALUES ($1, $2, $3, now())",
            vec![
                pid(observer_id.get()),
                Bind::Uuid(game),
                pid(invitation_id.get()),
            ],
        )],
        // 資格の失効・再発行は、周辺ストア（credentials・browser_sessions）に書く。投影の表は変わらない
        GameEvent::CredentialRevoked { .. } | GameEvent::CredentialReissued { .. } => Vec::new(),
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

/// 当週の入力の保存（参加者の保存と進行役の代理入力で共通）。
fn decision_statements(
    game: Uuid,
    week: Week,
    role: Role,
    quantity: Quantity,
    decision_version: DecisionVersion,
    (kind, who): (&'static str, u128),
    submitted_role_count: usize,
) -> Vec<Statement> {
    vec![
        st(
            "INSERT INTO current_decisions (game_id, role, week, quantity, decision_version, editor_kind, editor_id, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, now()) \
             ON CONFLICT (game_id, role) DO UPDATE SET week = EXCLUDED.week, quantity = EXCLUDED.quantity, \
             decision_version = EXCLUDED.decision_version, editor_kind = EXCLUDED.editor_kind, \
             editor_id = EXCLUDED.editor_id, updated_at = EXCLUDED.updated_at",
            vec![
                Bind::Uuid(game),
                Bind::Text(role_name(role).to_owned()),
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
                Bind::Int(i64::try_from(submitted_role_count).unwrap_or(0)),
            ],
        ),
    ]
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
        } => decision_statements(
            game,
            *week,
            *role,
            *quantity,
            *decision_version,
            editor_parts(editor),
            *submitted_role_count,
        ),
        SessionEvent::WeekCommitted {
            week,
            commit_kind,
            results,
            next_states,
            contributors,
            ..
        } => {
            let mut statements = vec![st(
                "INSERT INTO week_commits (game_id, week, commit_kind, contributors, stream_version, committed_at) \
                 VALUES ($1, $2, $4, $3, (SELECT max(stream_version) FROM events WHERE game_id = $1 AND stream_type = 'SESSION'), now())",
                vec![
                    Bind::Uuid(game),
                    Bind::Int(i64::from(week.get())),
                    Bind::Int(i64::try_from(*contributors).unwrap_or(0)),
                    Bind::Text(
                        match commit_kind {
                            CommitKind::Manual => "MANUAL",
                            CommitKind::Auto => "AUTO",
                        }
                        .to_owned(),
                    ),
                ],
            )];
            // 観察者向けのチーム合計（役割別の値は含まない。寄与者が 2 未満の週は、問い合わせの側で値を隠す）
            let sum = |f: &dyn Fn(&beergame_domain::RoleWeekResult) -> i64| -> i64 {
                results.values().iter().map(|r| f(r)).sum()
            };
            statements.push(st(
                "INSERT INTO week_team_totals (game_id, week, total_ordered, total_inventory, total_backlog, contributors) \
                 VALUES ($1, $2, $3, $4, $5, $6)",
                vec![
                    Bind::Uuid(game),
                    Bind::Int(i64::from(week.get())),
                    Bind::Int(sum(&|r| i64::from(r.ordered.get()))),
                    Bind::Int(sum(&|r| i64::from(r.ending_inventory.get()))),
                    Bind::Int(sum(&|r| i64::from(r.ending_backlog.get()))),
                    Bind::Int(i64::try_from(*contributors).unwrap_or(0)),
                ],
            ));
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
        SessionEvent::ProxyDecisionSubmitted {
            week,
            role,
            quantity,
            decision_version,
            operator,
            submitted_role_count,
        } => decision_statements(
            game,
            *week,
            *role,
            *quantity,
            *decision_version,
            ("FACILITATOR", operator.get()),
            *submitted_role_count,
        ),
        SessionEvent::CommitModeChanged { mode } => vec![st(
            "UPDATE game_overview SET commit_mode = $2 WHERE game_id = $1",
            vec![
                Bind::Uuid(game),
                Bind::Text(
                    match mode {
                        beergame_domain::CommitMode::Manual => "MANUAL",
                        beergame_domain::CommitMode::Auto => "AUTO",
                    }
                    .to_owned(),
                ),
            ],
        )],
        // 担当者の入れ替えは、投影（lobby_participants）が game ストリームのイベントで更新する
        SessionEvent::RoleReplaced { .. } => Vec::new(),
        SessionEvent::SessionPaused => vec![st(
            "UPDATE session_overview SET status = 'PAUSED' WHERE game_id = $1",
            vec![Bind::Uuid(game)],
        )],
        SessionEvent::SessionResumed => vec![st(
            "UPDATE session_overview SET status = 'ACTIVE' WHERE game_id = $1",
            vec![Bind::Uuid(game)],
        )],
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

/// 変更した項目の API の値（`SettingsField`）。
fn field_name(field: SettingsField) -> &'static str {
    match field {
        SettingsField::InitialInventory => "INITIAL_INVENTORY",
        SettingsField::InitialFlow => "INITIAL_FLOW",
        SettingsField::OrderDelay => "ORDER_DELAY",
        SettingsField::ShipmentDelay => "SHIPMENT_DELAY",
        SettingsField::ProductionDelay => "PRODUCTION_DELAY",
        SettingsField::HoldingCost => "HOLDING_COST",
        SettingsField::BacklogCost => "BACKLOG_COST",
        SettingsField::Disclosure => "DISCLOSURE",
    }
}

fn role_inventory(conditions: &Conditions) -> Value {
    Value::Object(
        Role::ALL
            .into_iter()
            .map(|role| {
                (
                    role_name(role).to_owned(),
                    json!(conditions.initial_inventory.get(role).get()),
                )
            })
            .collect(),
    )
}

fn kind_text(kind: CredentialKind) -> &'static str {
    match kind {
        CredentialKind::Facilitator => "FACILITATOR",
        CredentialKind::Participant => "PARTICIPANT",
        CredentialKind::Observer => "OBSERVER",
        CredentialKind::ObserverInvitation => "OBSERVER_INVITATION",
    }
}

/// 周辺ストアへの書き込み（資格のダイジェスト・表示名）の文。イベントには入れない値（D7）。
#[must_use]
pub fn peripheral_statements(write: &PeripheralWrite) -> Statement {
    match write {
        PeripheralWrite::Credential {
            digest,
            game_id,
            kind,
            subject_id,
            key_version,
            issued_at,
            expires_at,
        } => st(
            "INSERT INTO credentials (credential_digest, game_id, kind, subject_id, key_version, issued_at, expires_at) \
             VALUES ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000), to_timestamp($7::double precision / 1000))",
            vec![
                Bind::Text(digest.clone()),
                pid(game_id.get()),
                Bind::Text(kind_text(*kind).to_owned()),
                pid(*subject_id),
                Bind::Int(i64::from(*key_version)),
                Bind::Int(issued_at.epoch_millis()),
                Bind::Int(expires_at.epoch_millis()),
            ],
        ),
        PeripheralWrite::BrowserSession {
            digest,
            game_id,
            kind,
            subject_id,
            key_version,
            expires_at,
        } => st(
            "INSERT INTO browser_sessions (credential_digest, game_id, actor_kind, actor_id, key_version, expires_at) \
             VALUES ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000))",
            vec![
                Bind::Text(digest.clone()),
                pid(game_id.get()),
                Bind::Text(kind_text(*kind).to_owned()),
                pid(*subject_id),
                Bind::Int(i64::from(*key_version)),
                Bind::Int(expires_at.epoch_millis()),
            ],
        ),
        PeripheralWrite::RevokeCredentials {
            game_id,
            subject_id,
        } => st(
            // 復帰資格を失効させ、発行済みのブラウザセッションを使えなくする（同じトランザクション）
            "WITH revoked AS (UPDATE credentials SET revoked_at = now() WHERE game_id = $1 AND subject_id = $2 AND revoked_at IS NULL) \
             DELETE FROM browser_sessions WHERE game_id = $1 AND actor_id = $2",
            vec![pid(game_id.get()), pid(*subject_id)],
        ),
        PeripheralWrite::Idempotency {
            game_id,
            scope,
            key_digest,
            request_digest,
            status_code,
            response,
            expires_at,
        } => st(
            "INSERT INTO idempotency_records (game_id, scope, key_digest, request_digest, status_code, response, expires_at) \
             VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::double precision / 1000))",
            vec![
                pid(game_id.get()),
                Bind::Text(scope.clone()),
                Bind::Text(key_digest.clone()),
                Bind::Text(request_digest.clone()),
                Bind::Int(i64::from(*status_code)),
                Bind::Bytes(response.clone()),
                Bind::Int(expires_at.epoch_millis()),
            ],
        ),
        PeripheralWrite::ObserverName {
            game_id,
            observer_id,
            name,
            at,
        } => st(
            "INSERT INTO display_profiles (game_id, actor_kind, actor_id, display_name, created_at) \
             VALUES ($1, 'OBSERVER', $2, $3, to_timestamp($4::double precision / 1000))",
            vec![
                pid(game_id.get()),
                pid(observer_id.get()),
                Bind::Text(name.clone()),
                Bind::Int(at.epoch_millis()),
            ],
        ),
        PeripheralWrite::DisplayName {
            game_id,
            participant_id,
            name,
            at,
        } => st(
            "INSERT INTO display_profiles (game_id, actor_kind, actor_id, display_name, created_at) \
             VALUES ($1, 'PARTICIPANT', $2, $3, to_timestamp($4::double precision / 1000))",
            vec![
                pid(game_id.get()),
                pid(participant_id.get()),
                Bind::Text(name.clone()),
                Bind::Int(at.epoch_millis()),
            ],
        ),
    }
}
