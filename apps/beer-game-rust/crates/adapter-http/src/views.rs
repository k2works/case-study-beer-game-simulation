//! 問い合わせの応答。**呼び出した人ごとに、開示の規則を掛ける**（AC2.1.1〜AC2.1.3）。
//! 参加者には自分の役割の値だけを返し、他の役割の値と将来の週の需要は返さない。小売店だけが当週の顧客需要を見られる。

use beergame_application::{
    EditorSnapshot, GameSnapshot, ObservationSnapshot, ResultRow, RetentionState, RoleSnapshot,
    SessionSnapshot,
};
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
fn role_status(r: &RoleSnapshot, viewer: &Viewer) -> Value {
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
    // 最後の保存者・保存の時刻。表示名は、同じ役割の共同担当と進行役にだけ示す（呼び出した人の役割の状況だけを返すので、ここに来るのは該当者だけ）
    status.insert(
        "decisionEditor".to_owned(),
        r.editor
            .as_ref()
            .map_or(Value::Null, |editor| editor_json(editor, viewer)),
    );
    status.insert(
        "decisionSavedAt".to_owned(),
        r.saved_at_millis
            .map_or(Value::Null, |ms| json!(rfc3339_millis(ms))),
    );
    Value::Object(status)
}

/// エポックのミリ秒を RFC 3339（UTC、ミリ秒）の文字列にする（暦の計算は days-from-civil の逆算）。
pub(crate) fn rfc3339_millis(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let in_day = millis.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1_000 % 60,
        in_day % 1_000
    )
}

fn result_row(r: &ResultRow) -> Value {
    json!({
        "role": role_name(r.role), "week": r.week, "orders": r.orders, "order": r.order,
        "inventory": r.inventory, "backlog": r.backlog, "shipment": r.shipment,
        "cost": r.cost, "cumulativeCost": r.cumulative_cost,
    })
}

/// 保存者（`DecisionEditor`）。`isSelf` は、呼び出した人自身が保存したか（進行役は代理入力のとき true）。
pub(crate) fn editor_json(editor: &EditorSnapshot, viewer: &Viewer) -> Value {
    let is_self = match viewer {
        Viewer::Facilitator => editor.is_proxy,
        Viewer::Participant(id, _) => editor.participant_id.is_some_and(|p| p.get() == *id),
    };
    if editor.is_proxy {
        json!({"kind": "FACILITATOR_PROXY", "displayName": Value::Null, "isSelf": is_self})
    } else {
        json!({"kind": "PARTICIPANT", "displayName": editor.display_name, "isSelf": is_self})
    }
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
                .map(|r| (role_name(r.role).to_owned(), role_status(r, viewer)))
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
                view.insert("roleStatus".to_owned(), role_status(own, viewer));
            }
            // 同じ役割の共同担当（自分を含む）。他の役割の担当者は含めない
            let holders: Vec<Value> = s
                .co_holders
                .iter()
                .filter(|h| h.role == *role)
                .map(|h| json!({"displayName": h.display_name, "isSelf": h.participant_id.get() == *id}))
                .collect();
            view.insert("coHolders".to_owned(), Value::Array(holders));
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
    view.insert("settingsKind".to_owned(), json!(g.settings_kind));
    view.insert("changedSettings".to_owned(), json!(g.changed_settings));
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
        Actor::Anonymous | Actor::Observer(_) => {}
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
        "settingsKind": g.settings_kind,
        "changedSettings": g.changed_settings,
        "commitMode": g.commit_mode,
        "participants": participants,
        "invitations": g.invitations.iter().map(|i| json!({
            "invitationId": uuid_text(i.invitation_id),
            "expiresAt": rfc3339_millis(i.expires_at_millis),
            "revoked": i.revoked,
            "createdAt": rfc3339_millis(i.created_at_millis),
        })).collect::<Vec<_>>(),
        "observers": g.observers.iter().map(|o| json!({
            "observerId": uuid_text(o.observer_id),
            "displayName": o.display_name,
            "joinedAt": rfc3339_millis(o.joined_at_millis),
        })).collect::<Vec<_>>(),
        "versions": {"game": g.game_version, "session": g.session_version},
    })
}

/// 終了後の振り返り。全役割の全週の結果を、週・役割の順に並べる（`SessionSnapshot.results` は並べ済み）。
pub(crate) fn review_view(s: &SessionSnapshot, g: &GameSnapshot) -> Value {
    json!({
        "gameId": uuid_text(s.game_id.get()),
        "finalWeek": s.final_week,
        "settingsKind": g.settings_kind,
        "changedSettings": g.changed_settings,
        "commitMode": g.commit_mode,
        "results": s.results.iter().map(result_row).collect::<Vec<_>>(),
        "versions": {"game": s.game_version, "session": s.session_version},
    })
}

/// 観察画面。現在週・完了状況・チーム合計だけ（役割別の値・将来の需要・参加コード・入力者は含まない）。
/// 公開範囲が `NONE` なら合計を出さず理由を示す。寄与者が 2 未満の週は、値を出さず `hidden` と理由だけ（逆算の防止）。
pub(crate) fn observation_view(o: &ObservationSnapshot) -> Value {
    let mut view = Map::new();
    view.insert("gameId".to_owned(), json!(uuid_text(o.game_id.get())));
    view.insert("status".to_owned(), json!(o.status));
    view.insert("finalWeek".to_owned(), json!(o.final_week));
    if let Some(session) = &o.session {
        view.insert("sessionStatus".to_owned(), json!(session.status));
        view.insert("week".to_owned(), json!(session.week));
        view.insert(
            "submittedRoleCount".to_owned(),
            json!(session.submitted_role_count),
        );
    }
    let totals = if o.disclosure == "NONE" {
        json!({"policy": "NONE", "hiddenReason": "DISCLOSURE_NONE", "weeks": []})
    } else {
        let weeks: Vec<Value> = o
            .weeks
            .iter()
            .map(|w| {
                if w.contributors < 2 {
                    json!({"week": w.week, "hidden": true, "reason": "CONTRIBUTORS_BELOW_MINIMUM"})
                } else {
                    json!({"week": w.week, "order": w.ordered, "inventory": w.inventory, "backlog": w.backlog})
                }
            })
            .collect();
        json!({"policy": "TEAM_TOTAL", "weeks": weeks})
    };
    view.insert("totals".to_owned(), totals);
    view.insert(
        "versions".to_owned(),
        json!({"game": o.game_version, "session": o.session_version}),
    );
    Value::Object(view)
}

/// 保持状態。削除が完了したゲームは、記録ごと無くなるので、完了の状態は無い。
pub(crate) fn retention_view(r: &RetentionState) -> Value {
    json!({
        "retentionDays": r.retention_days,
        "startsAt": rfc3339_millis(r.starts_at_millis),
        "deleteAfter": rfc3339_millis(r.delete_after_millis),
        "status": r.status,
        "attempt": r.attempt,
        "nextAttemptAt": r.next_attempt_at_millis.map(rfc3339_millis),
        "lastFailureCode": r.last_failure_code,
        "backupRetentionDays": beergame_application::BACKUP_RETENTION_DAYS,
    })
}
