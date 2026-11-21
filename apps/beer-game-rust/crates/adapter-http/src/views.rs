//! 問い合わせの応答。**呼び出した人ごとに、開示の規則を掛ける**（AC2.1.1〜AC2.1.3）。
//! 参加者には自分の役割の値だけを返し、他の役割の値と将来の週の需要は返さない。小売店だけが当週の顧客需要を見られる。

use beergame_application::{GameSnapshot, ResultRow, RoleSnapshot, SessionSnapshot};
use beergame_domain::{Actor, Role};
use serde_json::{Map, Value, json};
use uuid::Uuid;

pub(crate) fn role_name(role: Role) -> &'static str {
    match role {
        Role::Factory => "FACTORY",
        Role::Distributor => "DISTRIBUTOR",
        Role::Wholesaler => "WHOLESALER",
        Role::Retailer => "RETAILER",
    }
}

fn uuid_text(n: u128) -> String {
    Uuid::from_u128(n).to_string()
}

/// 役割別の状況。`customerDemand` は小売店にだけ含める（他の役割には項目ごと含めない）。
fn role_status(r: &RoleSnapshot) -> Value {
    let mut status = Map::new();
    status.insert("inventory".to_owned(), json!(r.inventory));
    status.insert("backlog".to_owned(), json!(r.backlog));
    status.insert("arrivals".to_owned(), json!(r.arrivals));
    status.insert("orders".to_owned(), json!(r.orders));
    if r.role == Role::Retailer {
        status.insert("customerDemand".to_owned(), json!(r.orders));
    }
    status.insert("decision".to_owned(), json!(r.decision));
    status.insert("decisionVersion".to_owned(), json!(r.decision_version));
    // 最後の保存者・保存の時刻は、共同担当（B6）で扱う
    status.insert("decisionEditor".to_owned(), Value::Null);
    status.insert("decisionSavedAt".to_owned(), Value::Null);
    Value::Object(status)
}

fn result_row(r: &ResultRow) -> Value {
    json!({
        "role": role_name(r.role), "week": r.week, "orders": r.orders, "order": r.order,
        "inventory": r.inventory, "backlog": r.backlog, "shipment": r.shipment,
        "cost": r.cost, "cumulativeCost": r.cumulative_cost,
    })
}

/// 進行の状態の見え方。
pub(crate) enum Viewer {
    Facilitator,
    /// 自分の ID と役割。
    Participant(u128, Role),
}

/// 進行の状態。進行役には全役割の状況と結果、参加者には自分の役割の状況だけ。
pub(crate) fn session_view(s: &SessionSnapshot, viewer: &Viewer) -> Value {
    let mut view = Map::new();
    view.insert("sessionId".to_owned(), json!(uuid_text(s.game_id.get())));
    view.insert("status".to_owned(), json!(s.status));
    view.insert("week".to_owned(), json!(s.week));
    view.insert(
        "submittedRoleCount".to_owned(),
        json!(s.submitted_role_count),
    );
    view.insert(
        "versions".to_owned(),
        json!({"game": s.game_version, "session": s.session_version}),
    );
    match viewer {
        Viewer::Facilitator => {
            view.insert("finalWeek".to_owned(), json!(s.final_week));
            let roles: Map<String, Value> = s
                .roles
                .iter()
                .map(|r| (role_name(r.role).to_owned(), role_status(r)))
                .collect();
            view.insert("roles".to_owned(), Value::Object(roles));
            view.insert(
                "results".to_owned(),
                Value::Array(s.results.iter().map(result_row).collect()),
            );
        }
        Viewer::Participant(id, role) => {
            view.insert("participantId".to_owned(), json!(uuid_text(*id)));
            view.insert("role".to_owned(), json!(role_name(*role)));
            if let Some(own) = s.roles.iter().find(|r| r.role == *role) {
                view.insert("roleStatus".to_owned(), role_status(own));
            }
        }
    }
    Value::Object(view)
}

/// ゲームの状態。進行役には参加コードと最終週、参加者には自分の ID と役割。
pub(crate) fn game_view(g: &GameSnapshot, actor: &Actor, role: Option<Role>) -> Value {
    let mut view = Map::new();
    view.insert("gameId".to_owned(), json!(uuid_text(g.game_id.get())));
    view.insert(
        "sessionId".to_owned(),
        if g.status == "PREPARING" {
            Value::Null
        } else {
            json!(uuid_text(g.game_id.get()))
        },
    );
    view.insert("status".to_owned(), json!(g.status));
    view.insert("settingsKind".to_owned(), json!("KIT"));
    view.insert("changedSettings".to_owned(), json!([]));
    view.insert("commitMode".to_owned(), json!(g.commit_mode));
    view.insert(
        "versions".to_owned(),
        json!({"game": g.game_version, "session": g.session_version}),
    );
    match actor {
        Actor::Facilitator(_) => {
            view.insert("joinCode".to_owned(), json!(g.join_code));
            view.insert("finalWeek".to_owned(), json!(g.final_week));
        }
        Actor::Participant(id) => {
            view.insert("participantId".to_owned(), json!(uuid_text(id.get())));
            if let Some(role) = role {
                view.insert("role".to_owned(), json!(role_name(role)));
            }
        }
        Actor::Anonymous => {}
    }
    Value::Object(view)
}

/// ロビー（進行役向け）。参加者の表示名と役割の一覧。観察者・招待は B9。
pub(crate) fn lobby_view(g: &GameSnapshot) -> Value {
    let participants: Vec<Value> = g
        .participants
        .iter()
        .map(|p| {
            json!({
                "participantId": uuid_text(p.participant_id.get()),
                "displayName": p.display_name,
                "role": p.role.map(role_name),
            })
        })
        .collect();
    json!({
        "gameId": uuid_text(g.game_id.get()),
        "status": g.status,
        "joinCode": g.join_code,
        "settingsKind": "KIT",
        "changedSettings": [],
        "commitMode": g.commit_mode,
        "participants": participants,
        "invitations": [],
        "observers": [],
        "versions": {"game": g.game_version, "session": g.session_version},
    })
}
