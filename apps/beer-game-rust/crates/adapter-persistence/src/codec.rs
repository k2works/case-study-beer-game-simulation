//! ドメインのイベントと JSON の変換（`EventCodec`）。`event_type` を判別子にし、スキーマ版は 1。
//! 個人情報・秘密（表示名・資格の値）はイベントに含まれない（D7）。不明な `event_type`・不正な値は、失敗にする。

use std::collections::BTreeSet;

use beergame_domain::{
    CommitKind, CommitMode, DecisionVersion, Editor, EndReason, GameEvent, GameId, GameSettings,
    Instant, JoinCode, Money, ParticipantId, Pipeline, Quantity, RetentionDays, Role, RoleMap,
    RoleState, RoleWeekResult, SessionEvent, Units, Week,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::store::EventCodec;

const SCHEMA_VERSION: i32 = 1;

type R<T> = Result<T, String>;

fn uuid_of(n: u128) -> String {
    Uuid::from_u128(n).to_string()
}

fn field<'a>(v: &'a Value, name: &str) -> R<&'a Value> {
    v.get(name).ok_or_else(|| format!("項目が無い: {name}"))
}

fn int(v: &Value, name: &str) -> R<i64> {
    field(v, name)?
        .as_i64()
        .ok_or_else(|| format!("整数ではない: {name}"))
}

fn text<'a>(v: &'a Value, name: &str) -> R<&'a str> {
    field(v, name)?
        .as_str()
        .ok_or_else(|| format!("文字列ではない: {name}"))
}

fn id(v: &Value, name: &str) -> R<u128> {
    Uuid::parse_str(text(v, name)?)
        .map(|u| u.as_u128())
        .map_err(|e| format!("{name}: {e}"))
}

fn e<T: std::fmt::Debug>(x: T) -> String {
    format!("{x:?}")
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Factory => "FACTORY",
        Role::Distributor => "DISTRIBUTOR",
        Role::Wholesaler => "WHOLESALER",
        Role::Retailer => "RETAILER",
    }
}

fn role_of(name: &str) -> R<Role> {
    Role::ALL
        .into_iter()
        .find(|r| role_name(*r) == name)
        .ok_or_else(|| format!("不明な役割: {name}"))
}

fn role_field(v: &Value, name: &str) -> R<Role> {
    role_of(text(v, name)?)
}

fn per_role<A>(m: &RoleMap<A>, f: impl Fn(&A) -> Value) -> Value {
    json!({
        "FACTORY": f(&m.factory),
        "DISTRIBUTOR": f(&m.distributor),
        "WHOLESALER": f(&m.wholesaler),
        "RETAILER": f(&m.retailer),
    })
}

fn read_per_role<A>(v: &Value, f: impl Fn(&Value) -> R<A>) -> R<RoleMap<A>> {
    Ok(RoleMap {
        factory: f(field(v, "FACTORY")?)?,
        distributor: f(field(v, "DISTRIBUTOR")?)?,
        wholesaler: f(field(v, "WHOLESALER")?)?,
        retailer: f(field(v, "RETAILER")?)?,
    })
}

fn units(v: &Value) -> R<Units> {
    Units::of(v.as_i64().ok_or("整数ではない")?).map_err(e)
}

fn quantity(v: &Value) -> R<Quantity> {
    Quantity::of(v.as_i64().ok_or("整数ではない")?).map_err(e)
}

fn week_of(n: i64) -> R<Week> {
    Week::of(n).map_err(e)
}

fn pipeline(p: &Pipeline) -> Value {
    Value::Array(p.0.iter().map(|u| json!(u.get())).collect())
}

fn read_pipeline(v: &Value) -> R<Pipeline> {
    let items = v.as_array().ok_or("配列ではない")?;
    Ok(Pipeline(items.iter().map(units).collect::<R<Vec<_>>>()?))
}

fn role_state(s: &RoleState) -> Value {
    json!({
        "inventory": s.inventory.get(),
        "backlog": s.backlog.get(),
        "orderPipeline": pipeline(&s.order_pipeline),
        "deliveryPipeline": pipeline(&s.delivery_pipeline),
        "cumulativeCost": s.cumulative_cost.minor(),
        "arrivals": s.arrivals.get(),
        "orders": s.orders.get(),
    })
}

fn read_role_state(v: &Value) -> R<RoleState> {
    Ok(RoleState {
        inventory: units(field(v, "inventory")?)?,
        backlog: units(field(v, "backlog")?)?,
        order_pipeline: read_pipeline(field(v, "orderPipeline")?)?,
        delivery_pipeline: read_pipeline(field(v, "deliveryPipeline")?)?,
        cumulative_cost: Money::of(int(v, "cumulativeCost")?).map_err(e)?,
        arrivals: units(field(v, "arrivals")?)?,
        orders: units(field(v, "orders")?)?,
    })
}

fn role_result(r: &RoleWeekResult) -> Value {
    json!({
        "orders": r.orders.get(),
        "shipped": r.shipped.get(),
        "ordered": r.ordered.get(),
        "endingInventory": r.ending_inventory.get(),
        "endingBacklog": r.ending_backlog.get(),
        "weeklyCost": r.weekly_cost.minor(),
        "cumulativeCost": r.cumulative_cost.minor(),
    })
}

fn read_role_result(v: &Value) -> R<RoleWeekResult> {
    Ok(RoleWeekResult {
        orders: units(field(v, "orders")?)?,
        shipped: units(field(v, "shipped")?)?,
        ordered: quantity(field(v, "ordered")?)?,
        ending_inventory: units(field(v, "endingInventory")?)?,
        ending_backlog: units(field(v, "endingBacklog")?)?,
        weekly_cost: Money::of(int(v, "weeklyCost")?).map_err(e)?,
        cumulative_cost: Money::of(int(v, "cumulativeCost")?).map_err(e)?,
    })
}

fn commit_mode_name(m: CommitMode) -> &'static str {
    match m {
        CommitMode::Manual => "MANUAL",
        CommitMode::Auto => "AUTO",
    }
}

fn read_commit_mode(name: &str) -> R<CommitMode> {
    match name {
        "MANUAL" => Ok(CommitMode::Manual),
        "AUTO" => Ok(CommitMode::Auto),
        other => Err(format!("不明な確定方式: {other}")),
    }
}

fn settings(s: &GameSettings) -> Value {
    json!({
        "finalWeek": s.final_week.get(),
        "demand": s.demand.to_ints(),
        "holdingCost": s.cost_policy.holding.minor(),
        "backlogCost": s.cost_policy.backlog.minor(),
        "commitMode": commit_mode_name(s.commit_mode),
    })
}

fn read_settings(v: &Value) -> R<GameSettings> {
    let demand: Vec<i64> = field(v, "demand")?
        .as_array()
        .ok_or("配列ではない: demand")?
        .iter()
        .map(|n| n.as_i64().ok_or_else(|| "整数ではない: demand".to_owned()))
        .collect::<R<_>>()?;
    let final_week = week_of(int(v, "finalWeek")?)?;
    let kit = GameSettings::kit(
        i64::from(final_week.get()),
        &demand,
        read_commit_mode(text(v, "commitMode")?)?,
    )
    .map_err(e)?;
    // 費用の単価は、キット準拠の値であることを確かめる（カスタム条件は B8）
    let holding = int(v, "holdingCost")?;
    let backlog = int(v, "backlogCost")?;
    if holding == kit.cost_policy.holding.minor() && backlog == kit.cost_policy.backlog.minor() {
        Ok(kit)
    } else {
        Err("キット準拠でない費用方針は未対応（カスタム条件は B8）".to_owned())
    }
}

fn assignments(a: &RoleMap<BTreeSet<ParticipantId>>) -> Value {
    per_role(a, |set| {
        Value::Array(set.iter().map(|p| json!(uuid_of(p.get()))).collect())
    })
}

fn read_assignments(v: &Value) -> R<RoleMap<BTreeSet<ParticipantId>>> {
    read_per_role(v, |set| {
        set.as_array()
            .ok_or("配列ではない")?
            .iter()
            .map(|p| {
                let s = p.as_str().ok_or("文字列ではない")?;
                Uuid::parse_str(s)
                    .map(|u| ParticipantId::new(u.as_u128()))
                    .map_err(e)
            })
            .collect::<R<BTreeSet<_>>>()
    })
}

fn editor(ed: &Editor) -> Value {
    match ed {
        Editor::ByParticipant(p) => json!({"kind": "PARTICIPANT", "id": uuid_of(p.get())}),
        Editor::ByFacilitator(g) => json!({"kind": "FACILITATOR", "id": uuid_of(g.get())}),
    }
}

fn read_editor(v: &Value) -> R<Editor> {
    let who = id(v, "id")?;
    match text(v, "kind")? {
        "PARTICIPANT" => Ok(Editor::ByParticipant(ParticipantId::new(who))),
        "FACILITATOR" => Ok(Editor::ByFacilitator(GameId::new(who))),
        other => Err(format!("不明な入力者: {other}")),
    }
}

/// `game` ストリームのイベントの変換。
pub struct GameCodec;

impl EventCodec<GameEvent> for GameCodec {
    fn projection(&self, game_id: Uuid, event: &GameEvent) -> Vec<crate::projection::Statement> {
        crate::projection::game_statements(game_id, event)
    }

    fn encode(&self, event: &GameEvent) -> R<(String, i32, Value)> {
        let (name, payload) = match event {
            GameEvent::GameCreated {
                game_id,
                join_code,
                settings: s,
                retention_days,
                facilitator_credential_expires_at,
            } => (
                "GameCreated",
                json!({
                    "gameId": uuid_of(game_id.get()),
                    "joinCode": join_code.as_str(),
                    "settings": settings(s),
                    "retentionDays": retention_days.get(),
                    "facilitatorCredentialExpiresAt": facilitator_credential_expires_at.epoch_millis(),
                }),
            ),
            GameEvent::ParticipantJoined {
                participant_id,
                credential_expires_at,
            } => (
                "ParticipantJoined",
                json!({"participantId": uuid_of(participant_id.get()), "credentialExpiresAt": credential_expires_at.epoch_millis()}),
            ),
            GameEvent::RoleAssigned {
                participant_id,
                role,
            } => (
                "RoleAssigned",
                json!({"participantId": uuid_of(participant_id.get()), "role": role_name(*role)}),
            ),
            GameEvent::RoleUnassigned {
                participant_id,
                role,
            } => (
                "RoleUnassigned",
                json!({"participantId": uuid_of(participant_id.get()), "role": role_name(*role)}),
            ),
            GameEvent::GameStarted { game_id } => {
                ("GameStarted", json!({"gameId": uuid_of(game_id.get())}))
            }
        };
        Ok((name.to_owned(), SCHEMA_VERSION, payload))
    }

    fn decode(&self, event_type: &str, _schema_version: i32, p: Value) -> R<GameEvent> {
        match event_type {
            "GameCreated" => Ok(GameEvent::GameCreated {
                game_id: GameId::new(id(&p, "gameId")?),
                join_code: JoinCode::of(text(&p, "joinCode")?).map_err(e)?,
                settings: read_settings(field(&p, "settings")?)?,
                retention_days: RetentionDays::of(int(&p, "retentionDays")?).map_err(e)?,
                facilitator_credential_expires_at: Instant::from_epoch_millis(int(
                    &p,
                    "facilitatorCredentialExpiresAt",
                )?),
            }),
            "ParticipantJoined" => Ok(GameEvent::ParticipantJoined {
                participant_id: ParticipantId::new(id(&p, "participantId")?),
                credential_expires_at: Instant::from_epoch_millis(int(&p, "credentialExpiresAt")?),
            }),
            "RoleAssigned" => Ok(GameEvent::RoleAssigned {
                participant_id: ParticipantId::new(id(&p, "participantId")?),
                role: role_field(&p, "role")?,
            }),
            "RoleUnassigned" => Ok(GameEvent::RoleUnassigned {
                participant_id: ParticipantId::new(id(&p, "participantId")?),
                role: role_field(&p, "role")?,
            }),
            "GameStarted" => Ok(GameEvent::GameStarted {
                game_id: GameId::new(id(&p, "gameId")?),
            }),
            other => Err(format!("不明なイベント: {other}")),
        }
    }
}

/// `session` ストリームのイベントの変換。
pub struct SessionCodec;

impl EventCodec<SessionEvent> for SessionCodec {
    fn encode(&self, event: &SessionEvent) -> R<(String, i32, Value)> {
        let (name, payload) = match event {
            SessionEvent::SessionStarted {
                game_id,
                settings: s,
                assignments: a,
                initial_states,
                commit_mode,
            } => (
                "SessionStarted",
                json!({
                    "gameId": uuid_of(game_id.get()),
                    "settings": settings(s),
                    "assignments": assignments(a),
                    "initialStates": per_role(initial_states, role_state),
                    "commitMode": commit_mode_name(*commit_mode),
                }),
            ),
            SessionEvent::DecisionSaved {
                week,
                role,
                quantity: q,
                decision_version,
                editor: ed,
                submitted_role_count,
            } => (
                "DecisionSaved",
                json!({
                    "week": week.get(), "role": role_name(*role), "quantity": q.get(),
                    "decisionVersion": decision_version.get(), "editor": editor(ed),
                    "submittedRoleCount": submitted_role_count,
                }),
            ),
            SessionEvent::WeekCommitted {
                week,
                commit_kind,
                decisions,
                results,
                next_states,
                contributors,
            } => (
                "WeekCommitted",
                json!({
                    "week": week.get(),
                    "commitKind": match commit_kind { CommitKind::Manual => "MANUAL" },
                    "decisions": per_role(decisions, |q| json!(q.get())),
                    "results": per_role(results, role_result),
                    "nextStates": per_role(next_states, role_state),
                    "contributors": contributors,
                }),
            ),
            SessionEvent::SessionEnded { reason } => (
                "SessionEnded",
                json!({"reason": match reason { EndReason::FinalWeek => "FINAL_WEEK" }}),
            ),
        };
        Ok((name.to_owned(), SCHEMA_VERSION, payload))
    }

    fn decode(&self, event_type: &str, _schema_version: i32, p: Value) -> R<SessionEvent> {
        match event_type {
            "SessionStarted" => Ok(SessionEvent::SessionStarted {
                game_id: GameId::new(id(&p, "gameId")?),
                settings: read_settings(field(&p, "settings")?)?,
                assignments: read_assignments(field(&p, "assignments")?)?,
                initial_states: read_per_role(field(&p, "initialStates")?, read_role_state)?,
                commit_mode: read_commit_mode(text(&p, "commitMode")?)?,
            }),
            "DecisionSaved" => Ok(SessionEvent::DecisionSaved {
                week: week_of(int(&p, "week")?)?,
                role: role_field(&p, "role")?,
                quantity: quantity(field(&p, "quantity")?)?,
                decision_version: DecisionVersion::new(
                    u32::try_from(int(&p, "decisionVersion")?).map_err(e)?,
                ),
                editor: read_editor(field(&p, "editor")?)?,
                submitted_role_count: usize::try_from(int(&p, "submittedRoleCount")?).map_err(e)?,
            }),
            "WeekCommitted" => Ok(SessionEvent::WeekCommitted {
                week: week_of(int(&p, "week")?)?,
                commit_kind: match text(&p, "commitKind")? {
                    "MANUAL" => CommitKind::Manual,
                    other => return Err(format!("不明な確定の種類: {other}")),
                },
                decisions: read_per_role(field(&p, "decisions")?, quantity)?,
                results: read_per_role(field(&p, "results")?, read_role_result)?,
                next_states: read_per_role(field(&p, "nextStates")?, read_role_state)?,
                contributors: usize::try_from(int(&p, "contributors")?).map_err(e)?,
            }),
            "SessionEnded" => match text(&p, "reason")? {
                "FINAL_WEEK" => Ok(SessionEvent::SessionEnded {
                    reason: EndReason::FinalWeek,
                }),
                other => Err(format!("不明な終了の理由: {other}")),
            },
            other => Err(format!("不明なイベント: {other}")),
        }
    }
}
