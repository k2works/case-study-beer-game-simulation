//! ステップ定義。薄く保ち、HTTP を呼んで応答・DB を確かめるだけ（業務ロジックは持たない）。

use cucumber::{given, then, when};
use serde_json::{Value, json};

use std::collections::BTreeMap;

use crate::world::{ApiWorld, GameCtx, Reply};

pub(crate) type R = Result<(), String>;

const ROLES: [(&str, &str); 4] = [
    ("工場", "FACTORY"),
    ("一次卸", "DISTRIBUTOR"),
    ("二次卸", "WHOLESALER"),
    ("小売店", "RETAILER"),
];

fn en(role: &str) -> Result<&'static str, String> {
    ROLES
        .iter()
        .find(|(ja, _)| *ja == role)
        .map(|(_, en)| *en)
        .ok_or_else(|| format!("未知の役割: {role}"))
}

pub(crate) fn kit_demand(final_week: usize) -> Vec<i64> {
    vec![4; final_week]
}

pub(crate) fn expect(condition: bool, message: &str) -> R {
    if condition {
        Ok(())
    } else {
        Err(message.to_owned())
    }
}

fn status(world: &ApiWorld) -> Result<u16, String> {
    Ok(world.reply()?.status)
}

fn code(world: &ApiWorld) -> Result<String, String> {
    Ok(world
        .reply()?
        .body
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned())
}

// ---- 作成 ----

#[given("進行役がゲームを作成していない")]
async fn no_game(world: &mut ApiWorld) -> R {
    world.ready().await
}

#[when("進行役が、有効なキット準拠の設定でゲームを作成する")]
async fn create_valid(world: &mut ApiWorld) -> R {
    world.create_game(12, &kit_demand(12)).await.map(|_| ())
}

#[when(
    regex = r"^進行役が、最終週 (\d+) で第 (\d+) 週の需要が (\d+) の設定でゲームを作成しようとする$"
)]
async fn create_invalid(world: &mut ApiWorld, final_week: i64, week: usize, value: i64) -> R {
    let mut demand = kit_demand(usize::try_from(final_week).map_err(|e| e.to_string())?);
    if let Some(slot) = demand.get_mut(week.saturating_sub(1)) {
        *slot = value;
    }
    world.create_game(final_week, &demand).await.map(|_| ())
}

#[given("進行役が、キット準拠のゲームを作成している")]
async fn created(world: &mut ApiWorld) -> R {
    let reply = world.create_game(12, &kit_demand(12)).await?;
    expect(reply.status == 201, "作成できなかった")
}

#[then("ゲームは作成されない")]
async fn not_created(world: &mut ApiWorld) -> R {
    expect(status(world)? == 422, "422 ではない")?;
    let now: i64 = sqlx::query_scalar("SELECT count(*) FROM game_roots")
        .fetch_one(world.pool()?)
        .await
        .map_err(|e| e.to_string())?;
    expect(now == world.roots_before, "ゲームが作られた")
}

#[then("誤りの対象は第 5 週であり、需要は 0 以上 1000 以下の整数にするという修正内容が示される")]
async fn demand_error(world: &mut ApiWorld) -> R {
    let first = world
        .reply()?
        .body
        .pointer("/errors/0")
        .cloned()
        .unwrap_or(Value::Null);
    expect(
        first.get("week") == Some(&json!(5)),
        "対象の週が第 5 週ではない",
    )?;
    expect(
        first
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|m| m.contains("0〜1000")),
        "修正内容が無い",
    )
}

// ---- 参加・割り当て・開始 ----

pub(crate) async fn join_named(world: &mut ApiWorld, name: &str) -> R {
    let join_code = world.game()?.join_code.clone();
    let key = world.next_key();
    let body = json!({"joinCode": join_code, "displayName": name}).to_string();
    let reply = world
        .call(
            "POST",
            "/api/v1/participations/join",
            None,
            Some(&key),
            &body,
        )
        .await?;
    if reply.status == 200 {
        let pid: String = sqlx::query_scalar("SELECT participant_id::text FROM lobby_participants WHERE game_id = $1::uuid ORDER BY joined_at DESC, participant_id DESC LIMIT 1")
            .bind(&world.game()?.id)
            .fetch_one(world.pool()?)
            .await
            .map_err(|e| e.to_string())?;
        let cookie = reply.cookie.clone().ok_or("参加者の Cookie が無い")?;
        let recovery = reply.recovery.clone().unwrap_or_default();
        let game = world.game_mut()?;
        game.recoveries.insert(pid.clone(), recovery);
        game.named.insert(name.to_owned(), (pid, cookie));
    }
    Ok(())
}

async fn assign(world: &mut ApiWorld, name: &str, role_ja: &str) -> R {
    let role = en(role_ja)?;
    let (pid, cookie) = world
        .game()?
        .named
        .get(name)
        .cloned()
        .ok_or_else(|| format!("参加者が無い: {name}"))?;
    let (game_id, facilitator) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    let key = world.next_key();
    let reply = world
        .call(
            "PUT",
            &format!("/api/v1/games/{game_id}/participants/{pid}/role"),
            Some(&facilitator),
            Some(&key),
            &json!({"role": role}).to_string(),
        )
        .await?;
    expect(reply.status == 200, "割り当てられなかった")?;
    // 同じ役割に複数人（共同担当）がいるとき、「その役割の参加者」は最初に割り当てた人
    world
        .game_mut()?
        .players
        .entry(role.to_owned())
        .or_insert((pid, cookie));
    Ok(())
}

async fn start_game(world: &mut ApiWorld) -> Result<u16, String> {
    let (game_id, facilitator) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    let key = world.next_key();
    Ok(world
        .call(
            "POST",
            &format!("/api/v1/games/{game_id}/start"),
            Some(&facilitator),
            Some(&key),
            "",
        )
        .await?
        .status)
}

#[given(regex = r"^\d+ 人の参加者が、(.+)にそれぞれ割り当てられている$")]
async fn assigned_roles(world: &mut ApiWorld, roles: String) -> R {
    for (i, role) in roles.split('、').enumerate() {
        let name = format!("参加者{}", i + 1);
        join_named(world, &name).await?;
        assign(world, &name, role).await?;
    }
    Ok(())
}

#[given(regex = r"^参加者「(.+)」が(.+)に割り当てられている$")]
async fn named_assigned(world: &mut ApiWorld, name: String, role: String) -> R {
    join_named(world, &name).await?;
    assign(world, &name, &role).await
}

#[given("進行役がゲームを開始している")]
async fn started(world: &mut ApiWorld) -> R {
    expect(start_game(world).await? == 200, "開始できなかった")
}

#[when(regex = r"^進行役がゲームを開始(する|しようとする)$")]
async fn start_when(world: &mut ApiWorld, _kind: String) -> R {
    start_game(world).await.map(|_| ())
}

#[then("ゲームは開始されない")]
async fn not_started(world: &mut ApiWorld) -> R {
    expect(status(world)? == 422, "422 ではない")
}

#[then(regex = r"^不足している役割として(.+)が示される$")]
async fn missing_role(world: &mut ApiWorld, role: String) -> R {
    let wanted = en(&role)?;
    let missing = world
        .reply()?
        .body
        .get("missingRoles")
        .cloned()
        .unwrap_or(Value::Null);
    expect(
        missing == json!([wanted]),
        &format!("不足の役割が違う: {missing}"),
    )
}

#[when(regex = r"^参加者が、有効な参加コードと表示名「(.+)」で参加する$")]
async fn join_valid(world: &mut ApiWorld, name: String) -> R {
    join_named(world, &name).await
}

#[when(regex = r"^参加者が、存在しない参加コードと表示名「(.+)」で参加しようとする$")]
async fn join_bogus(world: &mut ApiWorld, name: String) -> R {
    let key = world.next_key();
    world
        .call(
            "POST",
            "/api/v1/participations/join",
            None,
            Some(&key),
            &json!({"joinCode": "zzzzzzzzzzzz", "displayName": name}).to_string(),
        )
        .await
        .map(|_| ())
}

#[when(regex = r"^新しい参加者が、そのゲームの参加コードと表示名「(.+)」で参加しようとする$")]
async fn join_late(world: &mut ApiWorld, name: String) -> R {
    join_named(world, &name).await
}

#[then("参加者はロビーに参加している")]
async fn in_lobby(world: &mut ApiWorld) -> R {
    expect(status(world)? == 200, "参加できなかった")?;
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM lobby_participants WHERE game_id = $1::uuid")
            .bind(&world.game()?.id)
            .fetch_one(world.pool()?)
            .await
            .map_err(|e| e.to_string())?;
    expect(n == 1, "ロビーに 1 人いない")
}

#[then("参加者の復帰資格が保存されている")]
async fn credential_saved(world: &mut ApiWorld) -> R {
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM credentials WHERE game_id = $1::uuid AND kind = 'PARTICIPANT'",
    )
    .bind(&world.game()?.id)
    .fetch_one(world.pool()?)
    .await
    .map_err(|e| e.to_string())?;
    expect(n == 1, "参加者の資格が保存されていない")
}

#[then("参加者は参加できない")]
async fn cannot_join(world: &mut ApiWorld) -> R {
    expect(status(world)? >= 400, "参加できてしまった")
}

#[then("参加コードが無効であるという理由が示される")]
async fn invitation_invalid(world: &mut ApiWorld) -> R {
    expect(code(world)? == "game.invitation_invalid", "コードが違う")
}

#[then("参加の受付が終了しているという理由が示される")]
async fn registration_closed(world: &mut ApiWorld) -> R {
    expect(code(world)? == "game.not_preparing", "コードが違う")
}

#[when(regex = r"^進行役が、(.+)を(.+)に割り当てる$")]
async fn reassign(world: &mut ApiWorld, name: String, role: String) -> R {
    let before = world
        .game()?
        .players
        .iter()
        .find(|(_, (pid, _))| {
            world
                .game()
                .ok()
                .and_then(|g| g.named.get(&name))
                .is_some_and(|(p, _)| p == pid)
        })
        .map(|(r, _)| r.clone());
    world.moved_from = before.map(|b| (name.clone(), b));
    assign(world, &name, &role).await
}

async fn role_of(world: &ApiWorld, name: &str) -> Result<Option<String>, String> {
    let (pid, _) = world
        .game()?
        .named
        .get(name)
        .cloned()
        .ok_or("参加者が無い")?;
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT role FROM lobby_participants WHERE participant_id = $1::uuid",
    )
    .bind(pid)
    .fetch_one(world.pool()?)
    .await
    .map_err(|e| e.to_string())
}

#[then(regex = r"^(.+)は(.+)に割り当てられている$")]
async fn is_assigned(world: &mut ApiWorld, name: String, role: String) -> R {
    expect(
        role_of(world, &name).await?.as_deref() == Some(en(&role)?),
        "割り当てられていない",
    )
}

#[then(regex = r"^(.+)は(.+)には割り当てられていない$")]
async fn is_not_assigned(world: &mut ApiWorld, name: String, role: String) -> R {
    expect(
        role_of(world, &name).await?.as_deref() != Some(en(&role)?),
        "割り当てられている",
    )
}

#[then(regex = r"^(.+)から(.+)へ移したことが示される$")]
async fn moved(world: &mut ApiWorld, from: String, to: String) -> R {
    // API は、移した旨を明示する項目を返さない（応答は versions だけ）。元の役割にいて、いま移動先にいることで確かめる
    let moved = world.moved_from.clone().ok_or("移動前の役割が無い")?;
    expect(moved.1 == en(&from)?, "元の役割が違う")?;
    expect(
        role_of(world, &moved.0).await?.as_deref() == Some(en(&to)?),
        "移動先にいない",
    )
}

// ---- 状況（開示の規則）----

async fn fetch_state(world: &mut ApiWorld, role_ja: &str, query: &str) -> R {
    let (_, cookie) = world
        .game()?
        .players
        .get(en(role_ja)?)
        .cloned()
        .ok_or("参加者が無い")?;
    let id = world.game()?.id.clone();
    world
        .call(
            "GET",
            &format!("/api/v1/sessions/{id}/state{query}"),
            Some(&cookie),
            None,
            "",
        )
        .await
        .map(|_| ())
}

#[when(regex = r"^(.+)の参加者が、自分の役割の状況を取得する$")]
async fn get_own(world: &mut ApiWorld, role: String) -> R {
    fetch_state(world, &role, "").await
}

#[when(regex = r"^(.+)の参加者が、(.+)の状況を取得しようとする$")]
async fn get_other(world: &mut ApiWorld, who: String, target: String) -> R {
    fetch_state(world, &who, &format!("?role={}", en(&target)?)).await
}

#[then(regex = r"^(.+)の在庫、受注残、入荷、受注が返る$")]
async fn own_values(world: &mut ApiWorld, role: String) -> R {
    let body = &world.reply()?.body;
    let status = body.get("roleStatus").ok_or("roleStatus が無い")?;
    let all = ["inventory", "backlog", "arrivals", "orders"]
        .iter()
        .all(|k| status.get(*k).is_some());
    expect(
        all && body.get("role") == Some(&json!(en(&role)?)),
        "自分の役割の値が返らない",
    )
}

#[then("他の役割の値は含まれない")]
async fn no_others(world: &mut ApiWorld) -> R {
    let body = &world.reply()?.body;
    expect(
        body.get("roles").is_none() && body.get("results").is_none(),
        "他の役割の値が含まれる",
    )
}

#[then("権限エラーが返る")]
async fn forbidden(world: &mut ApiWorld) -> R {
    expect(status(world)? == 403, "403 ではない")
}

#[then("小売店の値は返らない")]
async fn no_retailer_values(world: &mut ApiWorld) -> R {
    let body = &world.reply()?.body;
    expect(
        body.get("roleStatus").is_none()
            && body.get("roles").is_none()
            && body.get("inventory").is_none(),
        "値が返った",
    )
}

#[then("当週の顧客需要は含まれない")]
async fn no_demand(world: &mut ApiWorld) -> R {
    expect(
        world
            .reply()?
            .body
            .pointer("/roleStatus/customerDemand")
            .is_none(),
        "顧客需要が含まれる",
    )
}

#[then("当週の顧客需要が含まれる")]
async fn has_demand(world: &mut ApiWorld) -> R {
    expect(
        world
            .reply()?
            .body
            .pointer("/roleStatus/customerDemand")
            .is_some(),
        "顧客需要が無い",
    )
}

#[then("将来の週の需要は含まれない")]
async fn no_future_demand(world: &mut ApiWorld) -> R {
    let text = world.reply()?.body.to_string();
    expect(
        !text.contains("\"demand\"") && !text.contains("futureDemand"),
        "将来の需要が含まれる",
    )
}

// ---- 意思決定 ----

async fn save(world: &mut ApiWorld, role_ja: &str, quantity: Value) -> R {
    save_in_week(world, role_ja, 1, quantity).await
}

async fn save_in_week(world: &mut ApiWorld, role_ja: &str, week: i64, quantity: Value) -> R {
    let role = en(role_ja)?;
    let (_, cookie) = world
        .game()?
        .players
        .get(role)
        .cloned()
        .ok_or("参加者が無い")?;
    let id = world.game()?.id.clone();
    let key = world.next_key();
    // 意思決定の版は、サーバーの現在の版（共同担当が別に保存していても追随する）
    let state = facilitator_state(world).await?;
    let version = state
        .pointer(&format!("/roles/{role}/decisionVersion"))
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(0);
    world.if_match = Some(version.to_string());
    let reply = world
        .call(
            "PUT",
            &format!("/api/v1/sessions/{id}/decisions"),
            Some(&cookie),
            Some(&key),
            &json!({"week": week, "quantity": quantity}).to_string(),
        )
        .await?;
    if reply.status == 200 {
        world
            .game_mut()?
            .versions
            .insert(role.to_owned(), version + 1);
    }
    Ok(())
}

#[when(regex = r"^(.+)の参加者が、当週の数量として (\d+) を保存する$")]
async fn save_ok(world: &mut ApiWorld, role: String, quantity: i64) -> R {
    save(world, &role, json!(quantity)).await?;
    expect(status(world)? == 200, "保存できなかった")
}

#[when(regex = r"^(.+)の参加者が、当週の数量として「(.*)」を保存しようとする$")]
async fn save_try(world: &mut ApiWorld, role: String, raw: String) -> R {
    // 入力を、そのまま JSON の値にする（整数・小数・空は、形の違う値として送る）
    let value = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
    save(world, &role, value).await
}

async fn facilitator_state(world: &mut ApiWorld) -> Result<Value, String> {
    let (id, cookie) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    Ok(world
        .call(
            "GET",
            &format!("/api/v1/sessions/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await?
        .body)
}

#[then(regex = r"^当週の(.+)の入力として (\d+) が保存される$")]
async fn saved_as(world: &mut ApiWorld, role: String, quantity: i64) -> R {
    let state = facilitator_state(world).await?;
    expect(
        state.pointer(&format!("/roles/{}/decision", en(&role)?)) == Some(&json!(quantity)),
        "入力が保存されていない",
    )
}

#[then(regex = r"^その入力は(発注|生産要請)として扱われる$")]
async fn treated_as(world: &mut ApiWorld, kind: String) -> R {
    // 流通役は発注、生産役（工場）は生産要請（AC2.2.1）。保存されるのは同じ「数量」で、種類は役割から決まる
    let last = world
        .games
        .last()
        .and_then(|g| g.versions.keys().last().cloned())
        .ok_or("保存した役割が無い")?;
    let factory = last == "FACTORY";
    expect((kind == "生産要請") == factory, "種類が役割と合わない")
}

#[then("数量は保存されない")]
async fn not_saved(world: &mut ApiWorld) -> R {
    expect(status(world)? == 422, "422 ではない")
}

#[then("数量の修正方法が示される")]
async fn fix_shown(world: &mut ApiWorld) -> R {
    expect(
        world.reply()?.body.pointer("/errors/0/field") == Some(&json!("quantity")),
        "修正方法が示されない",
    )
}

#[then(regex = r"^数量の保存は(受け付けられる|拒否される)$")]
async fn save_result(world: &mut ApiWorld, result: String) -> R {
    let accepted = status(world)? == 200;
    expect(accepted == (result == "受け付けられる"), "結果が違う")
}

// ---- 確定 ----

#[given(regex = r"^第 1 週の入力が、(.+)でそろっている$")]
async fn inputs_complete(world: &mut ApiWorld, list: String) -> R {
    for item in list.split('、').map(str::trim) {
        let (role, q) = item.rsplit_once(' ').ok_or("入力の形が違う")?;
        save(
            world,
            role.trim(),
            json!(q.trim().parse::<i64>().map_err(|e| e.to_string())?),
        )
        .await?;
        expect(
            status(world)? == 200,
            &format!("保存できなかった: {}", world.reply()?.body),
        )?;
    }
    Ok(())
}

#[given(regex = r"^第 1 週の入力が、(.+)であり、(.+)は未入力である$")]
async fn inputs_partial(world: &mut ApiWorld, list: String, _missing: String) -> R {
    inputs_complete(world, list).await
}

async fn commit(world: &mut ApiWorld, key: Option<String>) -> Result<Value, String> {
    let (id, facilitator) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    let state = facilitator_state(world).await?;
    let basis: serde_json::Map<String, Value> = ROLES
        .iter()
        .map(|(_, en)| {
            (
                (*en).to_owned(),
                state
                    .pointer(&format!("/roles/{en}/decisionVersion"))
                    .cloned()
                    .unwrap_or(json!(0)),
            )
        })
        .collect();
    let key = key.unwrap_or_else(|| world.next_key());
    let body = json!({"requestedWeek": 1, "basis": basis}).to_string();
    let reply = world
        .call(
            "POST",
            &format!("/api/v1/sessions/{id}/weeks/1/commit"),
            Some(&facilitator),
            Some(&key),
            &body,
        )
        .await?;
    if reply.status == 200 {
        // 確定すると、次の週の意思決定の版は 0 に戻る
        world.game_mut()?.versions.clear();
    }
    Ok(reply.body)
}

#[given("進行役が第 1 週を確定している")]
async fn committed(world: &mut ApiWorld) -> R {
    // 同じ要求の再送のために、冪等キーを固定する
    commit(world, Some("commit-fixed".to_owned())).await?;
    expect(status(world)? == 200, "確定できなかった")
}

#[when(regex = r"^進行役が第 1 週を確定(する|しようとする)$")]
async fn commit_when(world: &mut ApiWorld, _kind: String) -> R {
    commit(world, None).await.map(|_| ())
}

#[when("進行役が、同じ確定の要求をもう一度送る")]
async fn commit_again(world: &mut ApiWorld) -> R {
    commit(world, Some("commit-fixed".to_owned()))
        .await
        .map(|_| ())
}

#[when("進行役が、新しい要求で第 1 週をもう一度確定しようとする")]
async fn commit_new(world: &mut ApiWorld) -> R {
    commit(world, None).await.map(|_| ())
}

#[then(regex = r"^現在の週は第 (\d+) 週(になる|のままである)$")]
async fn current_week(world: &mut ApiWorld, week: i64, _tail: String) -> R {
    let state = facilitator_state(world).await?;
    expect(state.get("week") == Some(&json!(week)), "週が違う")
}

#[then("第 1 週の結果が、4 役割のそれぞれについて記録される")]
async fn results_recorded(world: &mut ApiWorld) -> R {
    let state = facilitator_state(world).await?;
    expect(
        state
            .get("results")
            .and_then(Value::as_array)
            .is_some_and(|r| r.len() == 4),
        "結果が 4 役割分ない",
    )
}

#[then("各役割の参加者が見る状況は、第 2 週のものになる")]
async fn participants_see_week2(world: &mut ApiWorld) -> R {
    let players: Vec<(String, String)> = world.game()?.players.values().cloned().collect();
    let id = world.game()?.id.clone();
    for (_, cookie) in players {
        let reply = world
            .call(
                "GET",
                &format!("/api/v1/sessions/{id}/state"),
                Some(&cookie),
                None,
                "",
            )
            .await?;
        expect(
            reply.body.get("week") == Some(&json!(2)),
            "参加者の週が第 2 週ではない",
        )?;
    }
    Ok(())
}

#[then("第 1 週の結果は 1 回分だけである")]
async fn results_once(world: &mut ApiWorld) -> R {
    let state = facilitator_state(world).await?;
    expect(
        state
            .get("results")
            .and_then(Value::as_array)
            .is_some_and(|r| r.len() == 4),
        "結果が 1 回分ではない",
    )?;
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM week_commits WHERE game_id = $1::uuid AND week = 1",
    )
    .bind(&world.game()?.id)
    .fetch_one(world.pool()?)
    .await
    .map_err(|e| e.to_string())?;
    expect(n == 1, "確定が 2 回記録された")
}

#[then("第 1 週はすでに確定されているという理由で拒否される")]
async fn already_committed(world: &mut ApiWorld) -> R {
    expect(
        code(world)? == "session.week_advanced",
        "week_advanced ではない",
    )
}

#[when("進行役が第 1 週の結果を取得する")]
async fn get_results(world: &mut ApiWorld) -> R {
    facilitator_state(world).await.map(|_| ())
}

#[then("4 役割のそれぞれについて、注文、在庫、受注残、出荷、費用が含まれる")]
async fn results_fields(world: &mut ApiWorld) -> R {
    let state = facilitator_state(world).await?;
    let results = state
        .get("results")
        .and_then(Value::as_array)
        .ok_or("results が無い")?;
    let complete = results.len() == 4
        && results.iter().all(|r| {
            ["order", "inventory", "backlog", "shipment", "cost"]
                .iter()
                .all(|k| r.get(*k).is_some())
        });
    expect(complete, "結果の項目が足りない")
}

#[then("週は確定されない")]
async fn not_committed(world: &mut ApiWorld) -> R {
    expect(status(world)? == 422, "422 ではない")
}

#[then(regex = r"^入力が不足している役割として(.+)が示される$")]
async fn missing_input(world: &mut ApiWorld, role: String) -> R {
    let missing = world
        .reply()?
        .body
        .get("missingRoles")
        .cloned()
        .unwrap_or(Value::Null);
    expect(
        missing == json!([en(&role)?]),
        &format!("不足の役割が違う: {missing}"),
    )
}

// ---- 決定論（2 つのゲーム）----

#[given("同じ設定の 2 つのゲームが、どちらも開始されている")]
async fn two_games(world: &mut ApiWorld) -> R {
    for _ in 0..2 {
        created(world).await?;
        assigned_roles(world, "小売店、二次卸、一次卸、工場".to_owned()).await?;
        started(world).await?;
    }
    Ok(())
}

#[given(regex = r"^どちらのゲームも、第 1 週の入力が、(.+)でそろっている$")]
async fn both_inputs(world: &mut ApiWorld, list: String) -> R {
    for i in 0..world.games.len() {
        world.current = Some(i);
        inputs_complete(world, list.clone()).await?;
    }
    world.current = None;
    Ok(())
}

#[when("どちらのゲームも第 1 週を確定する")]
async fn both_commit(world: &mut ApiWorld) -> R {
    for i in 0..world.games.len() {
        world.current = Some(i);
        commit(world, None).await?;
        expect(status(world)? == 200, "確定できなかった")?;
    }
    world.current = None;
    Ok(())
}

#[then("2 つのゲームの全役割の状態と費用が一致する")]
async fn same_results(world: &mut ApiWorld) -> R {
    let mut results = Vec::new();
    // 背景のゲームを除き、このシナリオで作った 2 つのゲームを比べる
    let games: Vec<GameCtx> = world.games.iter().rev().take(2).cloned().collect();
    for g in games {
        let reply = world
            .call(
                "GET",
                &format!("/api/v1/sessions/{}/state", g.id),
                Some(&g.facilitator),
                None,
                "",
            )
            .await?;
        results.push((
            reply.body.get("results").cloned(),
            reply.body.get("roles").cloned(),
        ));
    }
    expect(
        results.len() == 2 && results.first() == results.get(1),
        "2 つのゲームの結果が違う",
    )
}

// ---- 振り返り（US4.2） ----

#[given(regex = r"^進行役が、最終週 (\d+) のキット準拠のゲームを作成している$")]
async fn created_with_final_week(world: &mut ApiWorld, final_week: usize) -> R {
    let reply = world
        .create_game(
            i64::try_from(final_week).map_err(|e| e.to_string())?,
            &kit_demand(final_week),
        )
        .await?;
    expect(reply.status == 201, "作成できなかった")
}

/// 4 役割が同じ数量を保存し、進行役がその週を確定する。
async fn commit_week_with(world: &mut ApiWorld, week: usize, quantity: i64) -> R {
    let (id, facilitator) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    for (_, role) in ROLES {
        let (_, cookie) = world
            .game()?
            .players
            .get(role)
            .cloned()
            .ok_or("参加者が無い")?;
        let key = world.next_key();
        let reply = world
            .call(
                "PUT",
                &format!("/api/v1/sessions/{id}/decisions"),
                Some(&cookie),
                Some(&key),
                &json!({"week": week, "quantity": quantity}).to_string(),
            )
            .await?;
        expect(
            reply.status == 200,
            &format!("保存できない: {}", reply.body),
        )?;
    }
    let basis: serde_json::Map<String, Value> = ROLES
        .iter()
        .map(|(_, en)| ((*en).to_owned(), json!(1)))
        .collect();
    let key = world.next_key();
    let reply = world
        .call(
            "POST",
            &format!("/api/v1/sessions/{id}/weeks/{week}/commit"),
            Some(&facilitator),
            Some(&key),
            &json!({"requestedWeek": week, "basis": basis}).to_string(),
        )
        .await?;
    expect(
        reply.status == 200,
        &format!("確定できない: {}", reply.body),
    )
}

#[given(regex = r"^全 (\d+) 週が、各役割 (\d+) の入力で確定され、ゲームが終了している$")]
async fn all_weeks_committed(world: &mut ApiWorld, weeks: usize, quantity: i64) -> R {
    for week in 1..=weeks {
        commit_week_with(world, week, quantity).await?;
    }
    let state = facilitator_state(world).await?;
    expect(
        state.get("status") == Some(&json!("ENDED")),
        "ゲームが終了していない",
    )
}

#[given(regex = r"^第 (\d+) 週が、各役割 (\d+) の入力で確定されている$")]
async fn week_committed(world: &mut ApiWorld, week: usize, quantity: i64) -> R {
    commit_week_with(world, week, quantity).await
}

async fn fetch_review(world: &mut ApiWorld, cookie: Option<String>) -> R {
    let id = world.game()?.id.clone();
    world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/review"),
            cookie.as_deref(),
            None,
            "",
        )
        .await
        .map(|_| ())
}

#[when(regex = r"^進行役が振り返りを取得(する|しようとする)$")]
async fn facilitator_review(world: &mut ApiWorld, _kind: String) -> R {
    let cookie = world.game()?.facilitator.clone();
    fetch_review(world, Some(cookie)).await
}

#[when(regex = r"^(.+)の参加者が振り返りを取得(する|しようとする)$")]
async fn participant_review(world: &mut ApiWorld, role: String, _kind: String) -> R {
    let (_, cookie) = world
        .game()?
        .players
        .get(en(&role)?)
        .cloned()
        .ok_or("参加者が無い")?;
    fetch_review(world, Some(cookie)).await
}

#[when("資格の無い人が振り返りを取得しようとする")]
async fn anonymous_review(world: &mut ApiWorld) -> R {
    fetch_review(world, None).await
}

#[then(
    regex = r"^振り返りに、4 役割のそれぞれについて (\d+) 週分の注文・在庫・受注残・出荷・費用が含まれる$"
)]
async fn review_has_all(world: &mut ApiWorld, weeks: usize) -> R {
    expect(status(world)? == 200, "取得できていない")?;
    let results = world
        .reply()?
        .body
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .ok_or("results が無い")?;
    expect(results.len() == 4 * weeks, "結果の件数が違う")?;
    for (_, role) in ROLES {
        let mut found: Vec<i64> = results
            .iter()
            .filter(|row| row.get("role") == Some(&json!(role)))
            .filter_map(|row| row.get("week").and_then(Value::as_i64))
            .collect();
        found.sort_unstable();
        let expected: Vec<i64> = (1..=i64::try_from(weeks).map_err(|e| e.to_string())?).collect();
        expect(found == expected, &format!("{role} の週が不足: {found:?}"))?;
    }
    expect(
        results.iter().all(|row| {
            [
                "orders",
                "order",
                "inventory",
                "backlog",
                "shipment",
                "cost",
            ]
            .iter()
            .all(|key| row.get(*key).is_some())
        }),
        "指標が不足している行がある",
    )
}

#[then("ゲームがまだ終了していないという理由で拒否される")]
async fn rejected_not_ended(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 409 && code(world)? == "game.not_ended",
        &format!("終了前の拒否ではない: {}", world.reply()?.body),
    )
}

#[then("結果の一覧は含まれない")]
async fn no_results_list(world: &mut ApiWorld) -> R {
    expect(
        world.reply()?.body.get("results").is_none(),
        "値が含まれている",
    )
}

// ---- 停止・再開・代理入力（US3.1） ----

async fn facilitator_post(world: &mut ApiWorld, path: &str, body: &str) -> R {
    let (id, cookie) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    let key = world.next_key();
    world
        .call(
            "POST",
            &format!("/api/v1/sessions/{id}/{path}"),
            Some(&cookie),
            Some(&key),
            body,
        )
        .await
        .map(|_| ())
}

#[given("進行役がセッションを一時停止している")]
async fn paused(world: &mut ApiWorld) -> R {
    facilitator_post(world, "pause", "").await?;
    expect(status(world)? == 200, "停止できなかった")
}

#[when("進行役がセッションを一時停止する")]
async fn pause_when(world: &mut ApiWorld) -> R {
    facilitator_post(world, "pause", "").await
}

#[given("進行役がセッションを再開している")]
async fn resumed(world: &mut ApiWorld) -> R {
    facilitator_post(world, "resume", "").await?;
    expect(status(world)? == 200, "再開できなかった")
}

#[when("進行役がセッションを再開する")]
async fn resume_when(world: &mut ApiWorld) -> R {
    facilitator_post(world, "resume", "").await
}

#[when(regex = r"^(.+)の参加者が、セッションを一時停止しようとする$")]
async fn participant_pause(world: &mut ApiWorld, role: String) -> R {
    let (id, cookie) = (
        world.game()?.id.clone(),
        world
            .game()?
            .players
            .get(en(&role)?)
            .map(|(_, c)| c.clone())
            .ok_or("参加者が無い")?,
    );
    let key = world.next_key();
    world
        .call(
            "POST",
            &format!("/api/v1/sessions/{id}/pause"),
            Some(&cookie),
            Some(&key),
            "",
        )
        .await
        .map(|_| ())
}

#[then("停止中であるという理由で拒否される")]
async fn rejected_paused(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 409 && code(world)? == "session.paused",
        &format!("停止中の拒否ではない: {}", world.reply()?.body),
    )
}

#[then(regex = r"^セッションの状態は(進行中|停止中)である$")]
async fn session_status_is(world: &mut ApiWorld, label: String) -> R {
    let state = facilitator_state(world).await?;
    let expected = if label == "停止中" {
        "PAUSED"
    } else {
        "ACTIVE"
    };
    expect(
        state.get("status") == Some(&json!(expected)),
        &format!("状態が違う: {state}"),
    )
}

#[then(regex = r"^当週の(.+)の入力は (\d+) のまま残っている$")]
async fn input_remains(world: &mut ApiWorld, role: String, quantity: i64) -> R {
    let state = facilitator_state(world).await?;
    expect(
        state.pointer(&format!("/roles/{}/decision", en(&role)?)) == Some(&json!(quantity)),
        &format!("入力が残っていない: {state}"),
    )
}

#[then(regex = r"^当週の(.+)の入力は保存されていない$")]
async fn input_absent(world: &mut ApiWorld, role: String) -> R {
    let state = facilitator_state(world).await?;
    expect(
        state
            .pointer(&format!("/roles/{}/decision", en(&role)?))
            .is_none_or(Value::is_null),
        &format!("入力が保存されている: {state}"),
    )
}

#[given(regex = r"^(.+)の参加者が、第 (\d+) 週の数量として (\d+) を保存している$")]
async fn saved_in_week_given(world: &mut ApiWorld, role: String, week: i64, quantity: i64) -> R {
    save_in_week(world, &role, week, json!(quantity)).await?;
    expect(status(world)? == 200, "保存できなかった")
}

#[then(regex = r"^(.+)の参加者が、第 (\d+) 週の数量として (\d+) を保存できる$")]
async fn can_save_in_week(world: &mut ApiWorld, role: String, week: i64, quantity: i64) -> R {
    save_in_week(world, &role, week, json!(quantity)).await?;
    expect(
        status(world)? == 200,
        &format!("保存できない: {}", world.reply()?.body),
    )
}

async fn proxy(world: &mut ApiWorld, role_ja: &str, week: i64, quantity: i64) -> R {
    let (id, cookie) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    let key = world.next_key();
    world
        .call(
            "PUT",
            &format!("/api/v1/sessions/{id}/proxy-decisions/{}", en(role_ja)?),
            Some(&cookie),
            Some(&key),
            &json!({"requestedWeek": week, "quantity": quantity}).to_string(),
        )
        .await?;
    if status(world)? == 200 {
        let role = en(role_ja)?.to_owned();
        let next = world.game()?.versions.get(&role).copied().unwrap_or(0) + 1;
        world.game_mut()?.versions.insert(role, next);
    }
    Ok(())
}

#[when(
    regex = r"^進行役が、(工場|一次卸|二次卸|小売店)の代理入力として (\d+) を入力(する|しようとする)$"
)]
async fn proxy_when(world: &mut ApiWorld, role: String, quantity: i64, _k: String) -> R {
    proxy(world, &role, 1, quantity).await
}

#[given(regex = r"^進行役が、(工場|一次卸|二次卸|小売店)の代理入力として (\d+) を入力している$")]
async fn proxy_given(world: &mut ApiWorld, role: String, quantity: i64) -> R {
    proxy(world, &role, 1, quantity).await?;
    expect(status(world)? == 200, "代理入力できなかった")
}

#[when(
    regex = r"^進行役が、第 (\d+) 週の画面を見たまま、(工場|一次卸|二次卸|小売店)の代理入力として (\d+) を入力しようとする$"
)]
async fn proxy_stale(world: &mut ApiWorld, week: i64, role: String, quantity: i64) -> R {
    proxy(world, &role, week, quantity).await
}

#[when(regex = r"^(.+)の参加者が、(.+)の代理入力として (\d+) を入力しようとする$")]
async fn proxy_by_participant(world: &mut ApiWorld, who: String, role: String, quantity: i64) -> R {
    let (id, cookie) = (
        world.game()?.id.clone(),
        world
            .game()?
            .players
            .get(en(&who)?)
            .map(|(_, c)| c.clone())
            .ok_or("参加者が無い")?,
    );
    let key = world.next_key();
    world
        .call(
            "PUT",
            &format!("/api/v1/sessions/{id}/proxy-decisions/{}", en(&role)?),
            Some(&cookie),
            Some(&key),
            &json!({"requestedWeek": 1, "quantity": quantity}).to_string(),
        )
        .await
        .map(|_| ())
}

#[then(regex = r"^(.+)の代理入力 (\d+) が受け付けられる$")]
async fn proxy_accepted(world: &mut ApiWorld, role: String, quantity: i64) -> R {
    expect(
        status(world)? == 200,
        &format!("受け付けられない: {}", world.reply()?.body),
    )?;
    input_remains(world, role, quantity).await
}

#[then(regex = r"^第 (\d+) 週の結果はまだ記録されていない$")]
async fn week_result_absent(world: &mut ApiWorld, week: i64) -> R {
    let state = facilitator_state(world).await?;
    let results = state
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    expect(
        results.iter().all(|r| r.get("week") != Some(&json!(week))),
        "結果が記録されている",
    )
}

#[then(regex = r"^第 (\d+) 週はすでに確定されているという理由で、代理入力は拒否される$")]
async fn proxy_week_advanced(world: &mut ApiWorld, week: i64) -> R {
    expect(
        status(world)? == 409
            && code(world)? == "session.week_advanced"
            && world.reply()?.body.get("requestedWeek") == Some(&json!(week)),
        &format!("週の拒否ではない: {}", world.reply()?.body),
    )
}

async fn proxy_row(world: &ApiWorld) -> Result<(String, Value, bool), String> {
    let id = world.game()?.id.clone();
    let row: (String, Value, bool) = sqlx::query_as(
        "SELECT actor_kind, payload, occurred_at > now() - interval '5 minutes' FROM events \
         WHERE game_id = $1::uuid AND event_type = 'ProxyDecisionSubmitted' ORDER BY seq DESC LIMIT 1",
    )
    .bind(&id)
    .fetch_one(world.pool()?)
    .await
    .map_err(|e| format!("監査履歴に代理入力が無い: {e}"))?;
    Ok(row)
}

#[then(regex = r"^監査履歴に、操作者が進行役、役割が(.+)、値が (\d+) の代理入力が残っている$")]
async fn audit_has_proxy(world: &mut ApiWorld, role: String, quantity: i64) -> R {
    let (kind, payload, _) = proxy_row(world).await?;
    expect(kind == "FACILITATOR", "操作者が進行役ではない")?;
    expect(
        payload.get("role") == Some(&json!(en(&role)?))
            && payload.get("quantity") == Some(&json!(quantity)),
        &format!("役割・値が違う: {payload}"),
    )
}

#[then("その代理入力の時刻が記録されている")]
async fn proxy_time(world: &mut ApiWorld) -> R {
    let (_, _, recent) = proxy_row(world).await?;
    expect(recent, "時刻が記録されていない、または古い")
}

#[given(regex = r"^(.+)の参加者が、当週の数量を (\d+) 回保存している$")]
async fn saved_many(world: &mut ApiWorld, role: String, times: i64) -> R {
    for quantity in 1..=times {
        save(world, &role, json!(quantity)).await?;
        expect(
            status(world)? == 200,
            &format!("{quantity} 回目の保存ができない: {}", world.reply()?.body),
        )?;
    }
    Ok(())
}

#[when(regex = r"^(.+)の参加者が、当週の数量をもう 1 回保存しようとする$")]
async fn save_one_more(world: &mut ApiWorld, role: String) -> R {
    save(world, &role, json!(99)).await
}

#[then("保存回数の上限に達しているという理由で拒否される")]
async fn rejected_save_limit(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 409 && code(world)? == "session.save_limit_reached",
        &format!("上限の拒否ではない: {}", world.reply()?.body),
    )
}

// ---- 復帰・失効・再発行・鍵の版（US3.2） ----

fn participant_of(world: &ApiWorld, role_ja: &str) -> Result<(String, String), String> {
    world
        .game()?
        .players
        .get(en(role_ja)?)
        .cloned()
        .ok_or_else(|| format!("参加者が無い: {role_ja}"))
}

/// 復帰を要求する。`recovery` は復帰資格の値、`as_code` なら本文の復帰コード、でなければ Cookie `bg_recovery`。
async fn recover_with(world: &mut ApiWorld, recovery: &str, as_code: bool, key: Option<&str>) -> R {
    let game_id = world.game()?.id.clone();
    let (body, cookie) = if as_code {
        (json!({"gameId": game_id, "recoveryCode": recovery}), None)
    } else {
        (
            json!({"gameId": game_id}),
            Some(format!("bg_recovery={recovery}")),
        )
    };
    world
        .call(
            "POST",
            "/api/v1/participations/recover",
            cookie.as_deref(),
            key,
            &body.to_string(),
        )
        .await?;
    Ok(())
}

async fn recover_participant(world: &mut ApiWorld, role_ja: &str, key: Option<&str>) -> R {
    let (pid, _) = participant_of(world, role_ja)?;
    let recovery = world
        .game()?
        .recoveries
        .get(&pid)
        .cloned()
        .ok_or("復帰資格が無い")?;
    recover_with(world, &recovery, false, key).await?;
    if status(world)? == 200 {
        let cookie = world
            .reply()?
            .cookie
            .clone()
            .ok_or("復帰の Cookie が無い")?;
        world.recovered = Some((cookie, pid));
    }
    Ok(())
}

#[given(regex = r"^(.+)の参加者のブラウザセッションが失われている$")]
async fn lost_session(_world: &mut ApiWorld, _role: String) -> R {
    Ok(())
}

#[given("進行役のブラウザセッションが失われている")]
async fn facilitator_lost_session(_world: &mut ApiWorld) -> R {
    Ok(())
}

#[given("進行役のブラウザセッションと復帰資格が失われている")]
async fn facilitator_lost_all(_world: &mut ApiWorld) -> R {
    Ok(())
}

#[when(regex = r"^(.+)の参加者が、復帰資格で再接続(する|しようとする)$")]
async fn participant_recovers(world: &mut ApiWorld, role: String, _k: String) -> R {
    recover_participant(world, &role, None).await
}

#[given(regex = r"^(.+)の参加者が、冪等キー付きで復帰資格で再接続している$")]
async fn participant_recovered_with_key(world: &mut ApiWorld, role: String) -> R {
    recover_participant(world, &role, Some("recover-fixed")).await?;
    expect(status(world)? == 200, "復帰できなかった")
}

#[when(regex = r"^(.+)の参加者が、以前に成功した復帰の要求を、同じキーでもう一度送る$")]
async fn participant_recover_again(world: &mut ApiWorld, role: String) -> R {
    recover_participant(world, &role, Some("recover-fixed")).await
}

#[when(regex = r"^(.+)の参加者が、新しい復帰コードで復帰する$")]
async fn recover_with_new_code(world: &mut ApiWorld, role: String) -> R {
    recover_with_reissued(world, &role).await?;
    expect(status(world)? == 200, "復帰できなかった")
}

async fn recover_with_reissued(world: &mut ApiWorld, role_ja: &str) -> R {
    let (pid, _) = participant_of(world, role_ja)?;
    let code = world
        .game()?
        .reissued
        .get(&pid)
        .cloned()
        .ok_or("再発行した復帰コードが無い")?;
    recover_with(world, &code, true, None).await?;
    if status(world)? == 200 {
        let cookie = world
            .reply()?
            .cookie
            .clone()
            .ok_or("復帰の Cookie が無い")?;
        world.recovered = Some((cookie, pid));
    }
    Ok(())
}

#[then(regex = r"^(.+)の参加者は、新しい復帰コードで同じゲームの(.+)として復帰できる$")]
async fn can_recover_with_new_code(world: &mut ApiWorld, who: String, role: String) -> R {
    recover_with_reissued(world, &who).await?;
    recovered_as(world, role).await
}

#[then(regex = r"^同じゲームの(工場|一次卸|二次卸|小売店)として復帰する$")]
async fn recovered_as(world: &mut ApiWorld, role: String) -> R {
    expect(
        status(world)? == 200,
        &format!("復帰できていない: {}", world.reply()?.body),
    )?;
    let game_id = world.game()?.id.clone();
    expect(
        world.reply()?.body.get("gameId") == Some(&json!(game_id)),
        "別のゲームに復帰した",
    )?;
    let (cookie, pid) = world.recovered.clone().ok_or("復帰の Cookie が無い")?;
    world
        .call(
            "GET",
            &format!("/api/v1/games/{game_id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await?;
    let body = world.reply()?.body.clone();
    expect(
        status(world)? == 200
            && body.get("role") == Some(&json!(en(&role)?))
            && body.get("participantId") == Some(&json!(pid)),
        &format!("役割・参加者が違う: {body}"),
    )
}

#[then(regex = r"^最新の状況に、保存済みの入力 (\d+) が含まれる$")]
async fn latest_has_decision(world: &mut ApiWorld, quantity: i64) -> R {
    let (cookie, _) = world.recovered.clone().ok_or("復帰の Cookie が無い")?;
    let id = world.game()?.id.clone();
    world
        .call(
            "GET",
            &format!("/api/v1/sessions/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await?;
    let body = world.reply()?.body.clone();
    expect(
        body.pointer("/roleStatus/decision") == Some(&json!(quantity)),
        &format!("保存済みの入力が無い: {body}"),
    )
}

#[given(regex = r"^(.+)の参加者の復帰資格が「(.+)」になっている$")]
async fn recovery_credential_is(world: &mut ApiWorld, role: String, state: String) -> R {
    let (pid, _) = participant_of(world, &role)?;
    match state.as_str() {
        "不明" => {
            world
                .game_mut()?
                .recoveries
                .insert(pid, "unknown-recovery-credential".to_owned());
            Ok(())
        }
        "失効" => revoke(world, &pid).await,
        "期限切れ" => {
            sqlx::query(
                "UPDATE credentials SET expires_at = now() - interval '1 day' WHERE subject_id = $1::uuid",
            )
            .bind(&pid)
            .execute(world.pool()?)
            .await
            .map_err(|e| e.to_string())?;
            Ok(())
        }
        other => Err(format!("知らない状態: {other}")),
    }
}

#[then("復帰は拒否される")]
async fn recovery_rejected(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 403 && code(world)? == "app.unauthorized",
        &format!("権限エラーではない: {}", world.reply()?.body),
    )
}

#[then("拒否の応答は、不明な復帰資格のときと同じである")]
async fn rejection_is_indistinguishable(world: &mut ApiWorld) -> R {
    let actual = world.reply()?.clone();
    recover_with(world, "unknown-credential-xyz", false, None).await?;
    let unknown = world.reply()?.clone();
    expect(actual.status == unknown.status, "状態が違う")?;
    for key in ["type", "title", "status", "detail", "code"] {
        expect(
            actual.body.get(key) == unknown.body.get(key),
            &format!("{key} が不明な資格と違う"),
        )?;
    }
    Ok(())
}

#[then("新しいブラウザセッションは発行されない")]
async fn no_new_session(world: &mut ApiWorld) -> R {
    expect(
        world.reply()?.cookie.is_none(),
        "新しいブラウザセッションが発行された",
    )
}

// 複数のタブ（AC3.2.3）

#[given(regex = r"^(.+)の参加者が、2 つのタブで第 (\d+) 週の画面を開いている$")]
async fn two_tabs(world: &mut ApiWorld, role: String, _week: i64) -> R {
    world.stale_version = world.game()?.versions.get(en(&role)?).copied().unwrap_or(0);
    Ok(())
}

#[when(regex = r"^(.+)の参加者の古いタブが、第 (\d+) 週の数量として (\d+) を保存しようとする$")]
async fn stale_tab_saves(world: &mut ApiWorld, role: String, week: i64, quantity: i64) -> R {
    let (_, cookie) = participant_of(world, &role)?;
    let id = world.game()?.id.clone();
    let key = world.next_key();
    world.if_match = Some(world.stale_version.to_string());
    world
        .call(
            "PUT",
            &format!("/api/v1/sessions/{id}/decisions"),
            Some(&cookie),
            Some(&key),
            &json!({"week": week, "quantity": quantity}).to_string(),
        )
        .await
        .map(|_| ())
}

#[then(regex = r"^古いタブの保存は、第 (\d+) 週はすでに確定されているという理由で拒否される$")]
async fn stale_tab_rejected(world: &mut ApiWorld, week: i64) -> R {
    let body = world.reply()?.body.clone();
    expect(
        status(world)? == 409
            && code(world)? == "session.week_advanced"
            && body.get("requestedWeek") == Some(&json!(week))
            && body.get("currentWeek") == Some(&json!(week + 1)),
        &format!("週の拒否ではない: {body}"),
    )
}

#[then(regex = r"^(.+)の参加者のもう一方のタブは、最新の状況として第 (\d+) 週を表示する$")]
async fn other_tab_latest(world: &mut ApiWorld, role: String, week: i64) -> R {
    fetch_state(world, &role, "").await?;
    let body = world.reply()?.body.clone();
    expect(
        status(world)? == 200
            && body.get("week") == Some(&json!(week))
            && body
                .pointer("/roleStatus/decision")
                .is_none_or(Value::is_null),
        &format!("最新の状況ではない: {body}"),
    )
}

// 進行役の復帰（AC3.2.4）

#[when("進行役が、画面を再読み込みする")]
async fn facilitator_reloads(world: &mut ApiWorld) -> R {
    let (id, cookie) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    world.recovered = Some((cookie.clone(), String::new()));
    world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await
        .map(|_| ())
}

async fn facilitator_recover(world: &mut ApiWorld, as_code: bool) -> R {
    let recovery = world.game()?.recovery.clone();
    recover_with(world, &recovery, as_code, None).await?;
    if status(world)? == 200 {
        let cookie = world
            .reply()?
            .cookie
            .clone()
            .ok_or("復帰の Cookie が無い")?;
        world.recovered = Some((cookie, String::new()));
    }
    Ok(())
}

#[when("進行役が、復帰資格で再接続する")]
async fn facilitator_recovers(world: &mut ApiWorld) -> R {
    facilitator_recover(world, false).await
}

#[when("進行役が、作成時に控えた復帰コードで再接続する")]
async fn facilitator_recovers_with_code(world: &mut ApiWorld) -> R {
    facilitator_recover(world, true).await
}

#[then("同じゲームの進行コンソールが表示される")]
async fn console_shown(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 200,
        &format!("進行コンソールに戻れない: {}", world.reply()?.body),
    )?;
    let (cookie, _) = world.recovered.clone().ok_or("Cookie が無い")?;
    let (id, join_code) = (world.game()?.id.clone(), world.game()?.join_code.clone());
    world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await?;
    expect(
        world.reply()?.body.get("joinCode") == Some(&json!(join_code)),
        "進行役の状態を取得できない",
    )?;
    world
        .call(
            "GET",
            &format!("/api/v1/sessions/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await?;
    Ok(())
}

// 参加の応答のゲーム ID

#[then("応答に、参加したゲームの ID が含まれる")]
async fn response_has_game_id(world: &mut ApiWorld) -> R {
    let id = world.game()?.id.clone();
    expect(
        status(world)? == 200 && world.reply()?.body.get("gameId") == Some(&json!(id)),
        "参加の応答にゲームの ID が無い",
    )
}

// 失効・再発行（AC3.2.5）

async fn credential_call(
    world: &mut ApiWorld,
    action: &str,
    pid: &str,
    cookie: &str,
    game_id: &str,
) -> R {
    let key = world.next_key();
    world
        .call(
            "POST",
            &format!("/api/v1/games/{game_id}/credentials/{action}"),
            Some(cookie),
            Some(&key),
            &json!({"subject": {"kind": "PARTICIPANT", "id": pid}}).to_string(),
        )
        .await
        .map(|_| ())
}

async fn revoke(world: &mut ApiWorld, pid: &str) -> R {
    let (id, cookie) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    credential_call(world, "revoke", pid, &cookie, &id).await?;
    expect(
        status(world)? == 200,
        &format!("失効できない: {}", world.reply()?.body),
    )
}

#[when(regex = r"^進行役が、(.+)の参加者の資格を失効させ(る|ようとする)$")]
async fn facilitator_revokes(world: &mut ApiWorld, role: String, _k: String) -> R {
    let (pid, _) = participant_of(world, &role)?;
    let (id, cookie) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    credential_call(world, "revoke", &pid, &cookie, &id).await
}

#[given(regex = r"^進行役が、(.+)の参加者の資格を失効させている$")]
async fn facilitator_has_revoked(world: &mut ApiWorld, role: String) -> R {
    let (pid, _) = participant_of(world, &role)?;
    revoke(world, &pid).await
}

#[when(regex = r"^(.+)の参加者が、(.+)の参加者の資格を失効させようとする$")]
async fn participant_tries_to_revoke(world: &mut ApiWorld, actor: String, target: String) -> R {
    let (_, cookie) = participant_of(world, &actor)?;
    let (pid, _) = participant_of(world, &target)?;
    let id = world.game()?.id.clone();
    credential_call(world, "revoke", &pid, &cookie, &id).await
}

#[given("別のゲームの進行役がいる")]
async fn another_game_exists(world: &mut ApiWorld) -> R {
    let current = world.games.len().saturating_sub(1);
    let reply = world.create_game(12, &kit_demand(12)).await?;
    expect(reply.status == 201, "別のゲームを作成できない")?;
    // 操作中のゲームは元のまま（別のゲームの進行役は、最後に作ったゲームの資格）
    world.current = Some(current);
    Ok(())
}

#[when(regex = r"^別のゲームの進行役が、(.+)の参加者の資格を失効させようとする$")]
async fn other_facilitator_revokes(world: &mut ApiWorld, role: String) -> R {
    let (pid, _) = participant_of(world, &role)?;
    let cookie = world
        .games
        .last()
        .map(|g| g.facilitator.clone())
        .ok_or("別のゲームが無い")?;
    let id = world.game()?.id.clone();
    credential_call(world, "revoke", &pid, &cookie, &id).await
}

#[then("失効が受け付けられる")]
async fn revoke_accepted(world: &mut ApiWorld) -> R {
    expect(status(world)? == 200, "失効が受け付けられていない")
}

#[then("資格はすでに失効しているという理由で拒否される")]
async fn already_revoked(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 409 && code(world)? == "game.credential_already_revoked",
        &format!("失効済みの拒否ではない: {}", world.reply()?.body),
    )
}

async fn cannot_recover(world: &mut ApiWorld, role: &str) -> R {
    recover_participant(world, role, None).await?;
    expect(
        status(world)? == 403 && world.reply()?.cookie.is_none(),
        "復帰できてしまう",
    )
}

#[then(
    regex = r"^(.+)の参加者は、(?:復帰資格で復帰できない|失効した古い復帰資格では復帰できない)$"
)]
async fn participant_cannot_recover(world: &mut ApiWorld, role: String) -> R {
    cannot_recover(world, &role).await
}

#[then(regex = r"^(.+)の参加者は、以前のブラウザセッションでも状況を取得できない$")]
async fn old_session_unusable(world: &mut ApiWorld, role: String) -> R {
    let (_, cookie) = participant_of(world, &role)?;
    let id = world.game()?.id.clone();
    world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await?;
    expect(
        status(world)? == 403 && code(world)? == "app.unauthorized",
        "以前のブラウザセッションが使えてしまう",
    )
}

#[then(regex = r"^(.+)の参加者の資格(?:には影響しない|は有効なままである)$")]
async fn credential_remains(world: &mut ApiWorld, role: String) -> R {
    let (_, cookie) = participant_of(world, &role)?;
    let id = world.game()?.id.clone();
    world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await?;
    expect(status(world)? == 200, "資格が使えない")
}

async fn reissue(world: &mut ApiWorld, role: &str) -> R {
    let (pid, _) = participant_of(world, role)?;
    let (id, cookie) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    credential_call(world, "reissue", &pid, &cookie, &id).await?;
    if status(world)? == 200
        && let Some(code) = world
            .reply()?
            .body
            .get("recoveryCode")
            .and_then(Value::as_str)
            .map(str::to_owned)
    {
        world.game_mut()?.reissued.insert(pid, code);
    }
    Ok(())
}

#[when(regex = r"^進行役が、(.+)の参加者の資格を再発行する$")]
async fn facilitator_reissues(world: &mut ApiWorld, role: String) -> R {
    reissue(world, &role).await
}

#[given(regex = r"^進行役が、(.+)の参加者の資格を再発行している$")]
async fn facilitator_has_reissued(world: &mut ApiWorld, role: String) -> R {
    reissue(world, &role).await?;
    expect(status(world)? == 200, "再発行できない")
}

#[then("再発行が受け付けられる")]
async fn reissue_accepted(world: &mut ApiWorld) -> R {
    expect(status(world)? == 200, "再発行が受け付けられていない")
}

#[then("新しい復帰コードと、現在より後の有効期限が示される")]
async fn new_code_and_expiry(world: &mut ApiWorld) -> R {
    let body = world.reply()?.body.clone();
    let code_ok = body
        .get("recoveryCode")
        .and_then(Value::as_str)
        .is_some_and(|c| !c.is_empty());
    let expires = body
        .get("expiresAt")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let now: String =
        sqlx::query_scalar("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS')")
            .fetch_one(world.pool()?)
            .await
            .map_err(|e| e.to_string())?;
    // RFC 3339（UTC）の文字列は、辞書順が時刻順
    expect(
        code_ok && expires.len() >= 19 && expires[..19] > *now.as_str(),
        &format!("復帰コード・期限が違う: {body}"),
    )
}

#[given(regex = r"^ゲームは「(準備中|開始後)」である$")]
async fn game_is_in_phase(world: &mut ApiWorld, phase: String) -> R {
    if phase == "開始後" {
        expect(start_game(world).await? == 200, "開始できない")?;
    }
    Ok(())
}

// 期限切れ・失効後の再送（ADR-004）

#[given(regex = r"^(.+)の参加者のブラウザセッションの有効期限が切れている$")]
async fn session_expired(world: &mut ApiWorld, role: String) -> R {
    let (pid, _) = participant_of(world, &role)?;
    sqlx::query("UPDATE browser_sessions SET expires_at = now() - interval '1 day' WHERE actor_id = $1::uuid")
        .bind(&pid)
        .execute(world.pool()?)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[when(regex = r"^(.+)の参加者が、期限が切れた資格で状況を取得しようとする$")]
async fn get_with_expired(world: &mut ApiWorld, role: String) -> R {
    let (_, cookie) = participant_of(world, &role)?;
    let id = world.game()?.id.clone();
    world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await
        .map(|_| ())
}

async fn save_keyed(world: &mut ApiWorld, role: &str, week: i64, quantity: i64) -> R {
    let (_, cookie) = participant_of(world, role)?;
    let id = world.game()?.id.clone();
    world.if_match = Some("0".to_owned());
    world
        .call(
            "PUT",
            &format!("/api/v1/sessions/{id}/decisions"),
            Some(&cookie),
            Some("save-fixed"),
            &json!({"week": week, "quantity": quantity}).to_string(),
        )
        .await
        .map(|_| ())
}

#[given(regex = r"^(.+)の参加者が、冪等キー付きで第 (\d+) 週の数量 (\d+) を保存している$")]
async fn saved_with_key(world: &mut ApiWorld, role: String, week: i64, quantity: i64) -> R {
    save_keyed(world, &role, week, quantity).await?;
    expect(status(world)? == 200, "保存できなかった")
}

#[when(regex = r"^(.+)の参加者が、以前に成功した保存の要求を、同じキーでもう一度送る$")]
async fn save_again_same_key(world: &mut ApiWorld, role: String) -> R {
    save_keyed(world, &role, 1, 4).await
}

#[then("保存済みの応答は返らない")]
async fn stored_response_not_returned(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 403 && world.reply()?.body.get("versions").is_none(),
        "保存済みの応答が返った",
    )
}

// 鍵のローテーション（NF-S4）

#[when("運営者が、資格の署名鍵を新しい版へ更新する")]
async fn rotate_key_when(world: &mut ApiWorld) -> R {
    world.rebuild_with_keys(2, 6, vec![(1, 5)]).await
}

#[given("運営者が、資格の署名鍵を新しい版へ更新している")]
async fn rotate_key_given(world: &mut ApiWorld) -> R {
    world.rebuild_with_keys(2, 6, vec![(1, 5)]).await
}

#[when("運営者が、旧版の鍵を設定から外す")]
async fn drop_old_key(world: &mut ApiWorld) -> R {
    world.rebuild_with_keys(2, 6, Vec::new()).await
}

#[then(regex = r"^(.+)の参加者は、更新前に発行した復帰資格で復帰できる$")]
async fn recover_after_rotation(world: &mut ApiWorld, role: String) -> R {
    recover_participant(world, &role, None).await?;
    expect(status(world)? == 200, "復帰できない")
}

#[then(regex = r"^更新前に発行した(.+)の参加者のブラウザセッションで、状況を取得できる$")]
async fn session_after_rotation(world: &mut ApiWorld, role: String) -> R {
    credential_remains(world, role).await
}

#[then(
    regex = r"^更新前に発行した(.+)の参加者の資格は、復帰もブラウザセッションも権限エラーになる$"
)]
async fn old_credentials_rejected(world: &mut ApiWorld, role: String) -> R {
    cannot_recover(world, &role).await?;
    old_session_unusable(world, role).await
}

#[then("別のゲームの進行役の資格は、まだ使える")]
async fn other_facilitator_still_works(world: &mut ApiWorld) -> R {
    let (id, cookie) = world
        .games
        .last()
        .map(|g| (g.id.clone(), g.facilitator.clone()))
        .ok_or("別のゲームが無い")?;
    world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await?;
    expect(status(world)? == 200, "別のゲームの進行役の資格が使えない")
}

#[given(regex = r"^(.+)の参加者が、復帰資格で再接続している$")]
async fn participant_has_recovered(world: &mut ApiWorld, role: String) -> R {
    recover_participant(world, &role, None).await?;
    expect(status(world)? == 200, "復帰できなかった")
}

// ---- 参加の試行の窓（NF-S11） ----

async fn join_raw(world: &mut ApiWorld, body: &Value) -> R {
    world
        .call(
            "POST",
            "/api/v1/participations/join",
            None,
            None,
            &body.to_string(),
        )
        .await
        .map(|_| ())
}

#[given("同じ接続元が、存在しない参加コードで、上限の回数まで参加に失敗している")]
async fn failed_up_to_limit(world: &mut ApiWorld) -> R {
    for i in 0..10 {
        join_raw(
            world,
            &json!({"joinCode": "no-such-code", "displayName": format!("失敗{i}")}),
        )
        .await?;
        expect(status(world)? == 403, "403 ではない")?;
    }
    Ok(())
}

#[then("参加は、試行が多すぎるという理由で拒否される")]
async fn rejected_rate_limited(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 429 && code(world)? == "app.rate_limited",
        &format!("試行の上限の拒否ではない: {}", world.reply()?.body),
    )
}

#[then("再試行までの待ち時間が示される")]
async fn retry_after_shown(world: &mut ApiWorld) -> R {
    let seconds = world
        .reply()?
        .retry_after
        .as_deref()
        .and_then(|v| v.parse::<u32>().ok());
    expect(
        seconds.is_some_and(|s| (1..=600).contains(&s)),
        "Retry-After が無い、または範囲外",
    )
}

#[when("同じ接続元から、表示名の違う参加者が、上限を超える人数、有効な参加コードで参加する")]
async fn many_successful_joins(world: &mut ApiWorld) -> R {
    world.statuses.clear();
    for i in 0..12 {
        join_named(world, &format!("多数{i}")).await?;
        let reply = world.reply()?.status;
        world.statuses.push(reply);
    }
    Ok(())
}

#[then("どの参加も受け付けられる")]
async fn all_accepted(world: &mut ApiWorld) -> R {
    expect(
        !world.statuses.is_empty() && world.statuses.iter().all(|s| *s == 200),
        &format!("受け付けられない参加がある: {:?}", world.statuses),
    )
}

#[given("同じ接続元が、表示名の無い参加を、上限を超える回数送っている")]
async fn malformed_joins(world: &mut ApiWorld) -> R {
    let code = world.game()?.join_code.clone();
    for _ in 0..12 {
        join_raw(world, &json!({"joinCode": code})).await?;
        expect(status(world)? == 422, "422 ではない")?;
    }
    Ok(())
}

#[then("参加は受け付けられる")]
async fn join_accepted(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 200,
        &format!("受け付けられない: {}", world.reply()?.body),
    )
}

#[then("参加コードの付いた、準備中のゲームが作成される")]
async fn game_created_preparing(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 201,
        &format!("作成できていない: {}", world.reply()?.body),
    )?;
    let id = world.game()?.id.clone();
    let (join_code, state): (String, String) = sqlx::query_as(
        "SELECT c.join_code, o.status FROM game_join_codes c JOIN game_overview o USING (game_id) WHERE c.game_id = $1::uuid",
    )
    .bind(&id)
    .fetch_one(world.pool()?)
    .await
    .map_err(|e| e.to_string())?;
    expect(
        !join_code.is_empty() && state == "PREPARING",
        "参加コード・準備中の状態が違う",
    )
}

#[then("作成を同じ要求でもう一度送っても、ゲームは 1 つのままである")]
async fn resend_create_keeps_one(world: &mut ApiWorld) -> R {
    let first = world.reply()?.clone();
    let (key, body) = world.create_request.clone().ok_or("作成の要求が無い")?;
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM game_roots")
        .fetch_one(world.pool()?)
        .await
        .map_err(|e| e.to_string())?;
    let again = world
        .call("POST", "/api/v1/games", None, Some(&key), &body)
        .await?;
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM game_roots")
        .fetch_one(world.pool()?)
        .await
        .map_err(|e| e.to_string())?;
    expect(
        again.status == 201,
        &format!("再送の応答が違う: {}", again.body),
    )?;
    expect(
        again.location == first.location,
        "再送で別のゲームが作られた",
    )?;
    expect(again.cookie == first.cookie, "再送で別の資格が発行された")?;
    expect(
        again.body.get("recoveryCode") == first.body.get("recoveryCode"),
        "復帰コードが違う",
    )?;
    expect(before == after, "ゲームの数が増えた")
}

// ---- 共同担当（AC1.2.4・AC1.2.5） ----

#[given(regex = r"^参加者「(.+)」が、役割なしで参加している$")]
async fn joined_without_role(world: &mut ApiWorld, name: String) -> R {
    join_named(world, &name).await?;
    expect(status(world)? == 200, "参加できなかった")
}

#[then("ゲームは開始されている")]
async fn game_is_started(world: &mut ApiWorld) -> R {
    let state = facilitator_state(world).await?;
    expect(
        state.get("status") == Some(&json!("ACTIVE")),
        &format!("開始されていない: {state}"),
    )
}

#[then(regex = r"^(.+)に (\d+) 人の参加者が割り当てられている$")]
async fn role_has_n_participants(world: &mut ApiWorld, role: String, count: i64) -> R {
    let id = world.game()?.id.clone();
    let actual: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM lobby_participants WHERE game_id = $1::uuid AND role = $2",
    )
    .bind(&id)
    .bind(en(&role)?)
    .fetch_one(world.pool()?)
    .await
    .map_err(|e| e.to_string())?;
    expect(actual == count, &format!("{role} の人数が違う: {actual}"))
}

// ---- 共同入力（AC2.1.4・AC2.2.3・AC2.2.4・確定の区別） ----

/// 参加者（「小売店の参加者」はその役割の最初の担当者。それ以外は表示名）。（参加者 ID、Cookie、役割）
async fn holder(world: &ApiWorld, who: &str) -> Result<(String, String, String), String> {
    if let Some(label) = who.strip_suffix("の参加者") {
        let role = en(label)?.to_owned();
        let (pid, cookie) = world
            .game()?
            .players
            .get(&role)
            .cloned()
            .ok_or("参加者が無い")?;
        return Ok((pid, cookie, role));
    }
    let (pid, cookie) = world
        .game()?
        .named
        .get(who.trim())
        .cloned()
        .ok_or_else(|| format!("参加者が無い: {who}"))?;
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM lobby_participants WHERE participant_id = $1::uuid")
            .bind(&pid)
            .fetch_one(world.pool()?)
            .await
            .map_err(|e| e.to_string())?;
    Ok((pid, cookie, role.ok_or("役割が無い")?))
}

async fn holder_state(world: &mut ApiWorld, who: &str) -> Result<Value, String> {
    let (_, cookie, _) = holder(world, who).await?;
    let id = world.game()?.id.clone();
    Ok(world
        .call(
            "GET",
            &format!("/api/v1/sessions/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await?
        .body)
}

#[when(regex = r"^共同担当の(.+)が、自分の役割の状況を取得する$")]
async fn co_holder_fetches(world: &mut ApiWorld, name: String) -> R {
    holder_state(world, &name).await.map(|_| ())
}

async fn should_see(world: &mut ApiWorld, name: &str, quantity: i64, version: i64) -> R {
    let state = holder_state(world, name).await?;
    expect(
        state.pointer("/roleStatus/decision") == Some(&json!(quantity))
            && state.pointer("/roleStatus/decisionVersion") == Some(&json!(version)),
        &format!("{name} が見る入力値・版が違う: {state}"),
    )
}

#[then(regex = r"^(.+)が見る入力値は (\d+)、版は (\d+) である$")]
async fn sees_decision(world: &mut ApiWorld, name: String, quantity: i64, version: i64) -> R {
    should_see(world, &name, quantity, version).await
}

#[then(regex = r"^共同担当の(.+)が取得した状況は、入力値 (\d+)、版 (\d+) になる$")]
async fn co_holder_sees(world: &mut ApiWorld, name: String, quantity: i64, version: i64) -> R {
    should_see(world, &name, quantity, version).await
}

/// 誰が見ても同じ値になる項目（「自分かどうか」の印は、見る人ごとに違うので除く）。
fn shared_view(state: &Value) -> Value {
    let mut status = state.get("roleStatus").cloned().unwrap_or(Value::Null);
    let editor = status
        .as_object_mut()
        .and_then(|m| m.remove("decisionEditor"));
    json!({
        "status": state.get("status"), "week": state.get("week"), "role": state.get("role"),
        "submittedRoleCount": state.get("submittedRoleCount"), "roleStatus": status,
        "editorKind": editor.as_ref().and_then(|e| e.get("kind")),
        "editorName": editor.as_ref().and_then(|e| e.get("displayName")),
    })
}

#[then(regex = r"^(.+)が見る状況は、(.+)が見る状況と同じである$")]
async fn sees_same_situation(world: &mut ApiWorld, one: String, other: String) -> R {
    let first = shared_view(&holder_state(world, &one).await?);
    let second = shared_view(&holder_state(world, &other).await?);
    expect(
        first == second,
        &format!("見える状況が違う: {first} / {second}"),
    )
}

#[then(regex = r"^同じ役割の共同担当として、(.+)と(.+)が示される$")]
async fn co_holders_shown(world: &mut ApiWorld, one: String, other: String) -> R {
    let body = world.reply()?.body.clone();
    let entries = body
        .get("coHolders")
        .and_then(Value::as_array)
        .cloned()
        .ok_or("coHolders が無い")?;
    let mut names: Vec<String> = entries
        .iter()
        .filter_map(|e| {
            e.get("displayName")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    names.sort();
    let mut expected = vec![
        display_name_of(world, &one)?,
        display_name_of(world, &other)?,
    ];
    expected.sort();
    let selves = entries
        .iter()
        .filter(|e| e.get("isSelf") == Some(&json!(true)))
        .count();
    expect(
        names == expected && selves == 1,
        &format!("共同担当が違う: {names:?} / 自分の印 {selves}"),
    )
}

/// 表示名。「小売店の参加者」は、参加時の表示名（「参加者N」）を周辺ストアから引く。
fn display_name_of(world: &ApiWorld, who: &str) -> Result<String, String> {
    if who.ends_with("の参加者") {
        let pid = world
            .game()?
            .players
            .get(en(who.trim_end_matches("の参加者"))?)
            .map(|(p, _)| p.clone())
            .ok_or("参加者が無い")?;
        world
            .game()?
            .named
            .iter()
            .find(|(_, (p, _))| *p == pid)
            .map(|(name, _)| name.clone())
            .ok_or_else(|| "表示名が無い".to_owned())
    } else {
        Ok(who.trim().to_owned())
    }
}

#[then(regex = r"^(.+)が見る最後の保存者は、(.+)である$")]
async fn sees_last_editor(world: &mut ApiWorld, name: String, editor: String) -> R {
    let state = holder_state(world, &name).await?;
    let me_self = editor == "自分自身";
    let expected = if me_self {
        display_name_of(world, &name)?
    } else {
        display_name_of(world, &editor)?
    };
    let actual = state.pointer("/roleStatus/decisionEditor").cloned();
    expect(
        actual.as_ref().and_then(|e| e.get("kind")) == Some(&json!("PARTICIPANT"))
            && actual.as_ref().and_then(|e| e.get("displayName")) == Some(&json!(expected))
            && actual.as_ref().and_then(|e| e.get("isSelf")) == Some(&json!(me_self)),
        &format!("最後の保存者が違う: {actual:?}"),
    )
}

#[then("他の役割の担当者の表示名・ID は、どの項目にも含まれない")]
async fn others_not_disclosed(world: &mut ApiWorld) -> R {
    let text = world.reply()?.body.to_string();
    let own_role = world
        .reply()?
        .body
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let game = world.game()?.clone();
    let mut checked = 0;
    for (role, (pid, _)) in &game.players {
        if *role == own_role {
            continue;
        }
        checked += 1;
        let name = game
            .named
            .iter()
            .find(|(_, (p, _))| p == pid)
            .map(|(n, _)| n.clone())
            .unwrap_or_default();
        expect(
            !text.contains(pid.as_str())
                && (name.is_empty() || !text.contains(&format!("\"{name}\""))),
            &format!("他の役割の担当者が含まれている: {text}"),
        )?;
    }
    expect(checked > 0, "他の役割の参加者がいない")
}

#[then("入力値・版は、自分の役割のもの（入力なし、版 0）である")]
async fn values_are_own(world: &mut ApiWorld) -> R {
    let body = world.reply()?.body.clone();
    expect(
        body.pointer("/roleStatus/decision")
            .is_none_or(Value::is_null)
            && body.pointer("/roleStatus/decisionVersion") == Some(&json!(0))
            && body
                .pointer("/roleStatus/decisionEditor")
                .is_none_or(Value::is_null),
        &format!("自分の役割のものではない: {body}"),
    )
}

#[given(regex = r"^(.+)と(.+)が、同じ版の画面を見ている$")]
async fn both_see_same_version(world: &mut ApiWorld, one: String, other: String) -> R {
    let a = holder_state(world, &one).await?;
    let b = holder_state(world, &other).await?;
    let version = |s: &Value| {
        s.pointer("/roleStatus/decisionVersion")
            .and_then(Value::as_u64)
    };
    expect(version(&a) == version(&b), "同じ版を見ていない")?;
    world.stale_version = u32::try_from(version(&a).unwrap_or(0)).unwrap_or(0);
    Ok(())
}

async fn save_at_viewed(world: &mut ApiWorld, who: &str, quantity: i64) -> R {
    let (_, cookie, _) = holder(world, who).await?;
    let state = facilitator_state(world).await?;
    let week = state.get("week").and_then(Value::as_i64).unwrap_or(1);
    let id = world.game()?.id.clone();
    let key = world.next_key();
    world.if_match = Some(world.stale_version.to_string());
    world
        .call(
            "PUT",
            &format!("/api/v1/sessions/{id}/decisions"),
            Some(&cookie),
            Some(&key),
            &json!({"week": week, "quantity": quantity}).to_string(),
        )
        .await
        .map(|_| ())
}

#[given(regex = r"^(.+)が、見ていた版のまま、数量 (\d+) を保存している$")]
async fn has_saved_at_viewed(world: &mut ApiWorld, who: String, quantity: i64) -> R {
    save_at_viewed(world, &who, quantity).await?;
    expect(
        status(world)? == 200,
        &format!("保存できない: {}", world.reply()?.body),
    )
}

#[when(regex = r"^(.+)が、見ていた版のまま、数量 (\d+) を保存しようとする$")]
async fn tries_to_save_at_viewed(world: &mut ApiWorld, who: String, quantity: i64) -> R {
    save_at_viewed(world, &who, quantity).await
}

#[given(regex = r"^(.+)が、見ていた版のまま、数量 (\d+) を保存しようとして、競合している$")]
async fn has_conflicted(world: &mut ApiWorld, who: String, quantity: i64) -> R {
    save_at_viewed(world, &who, quantity).await?;
    expect(
        status(world)? == 409 && code(world)? == "session.decision_conflict",
        "競合になっていない",
    )
}

async fn save_now(world: &mut ApiWorld, who: &str, quantity: i64) -> R {
    let (_, cookie, role) = holder(world, who).await?;
    let state = facilitator_state(world).await?;
    let week = state.get("week").and_then(Value::as_i64).unwrap_or(1);
    let version = state
        .pointer(&format!("/roles/{role}/decisionVersion"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let id = world.game()?.id.clone();
    let key = world.next_key();
    world.if_match = Some(version.to_string());
    world
        .call(
            "PUT",
            &format!("/api/v1/sessions/{id}/decisions"),
            Some(&cookie),
            Some(&key),
            &json!({"week": week, "quantity": quantity}).to_string(),
        )
        .await
        .map(|_| ())
}

#[when(regex = r"^(.+)が、最新の版を指定して、数量 (\d+) を保存し直す$")]
async fn saves_again_at_latest(world: &mut ApiWorld, who: String, quantity: i64) -> R {
    save_now(world, &who, quantity).await
}

#[then("保存は競合として拒否される")]
async fn rejected_as_conflict(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 409 && code(world)? == "session.decision_conflict",
        &format!("競合として拒否されていない: {}", world.reply()?.body),
    )
}

fn latest_of(world: &ApiWorld) -> Result<Value, String> {
    world
        .reply()?
        .body
        .get("latest")
        .cloned()
        .ok_or_else(|| "競合の応答に latest が無い".to_owned())
}

#[then(regex = r"^競合の応答に、最新の入力 (\d+)、版 (\d+) が含まれる$")]
async fn conflict_has_latest(world: &mut ApiWorld, quantity: i64, version: i64) -> R {
    let latest = latest_of(world)?;
    expect(
        latest.get("quantity") == Some(&json!(quantity))
            && latest.get("version") == Some(&json!(version)),
        &format!("最新の入力・版が違う: {latest}"),
    )
}

#[then(regex = r"^最後の保存者として(.+)が、保存の時刻とともに示される$")]
async fn conflict_has_editor_and_time(world: &mut ApiWorld, name: String) -> R {
    let latest = latest_of(world)?;
    let editor = latest.get("editor").cloned().unwrap_or(Value::Null);
    let saved_at = latest
        .get("savedAt")
        .and_then(Value::as_str)
        .unwrap_or_default();
    expect(
        editor.get("kind") == Some(&json!("PARTICIPANT"))
            && editor.get("displayName") == Some(&json!(display_name_of(world, &name)?))
            && editor.get("isSelf") == Some(&json!(false))
            && saved_at.len() == 24
            && saved_at.ends_with('Z'),
        &format!("保存者・時刻が違う: {latest}"),
    )
}

#[then("最後の保存者は、進行役の代理入力として示される")]
async fn editor_is_proxy(world: &mut ApiWorld) -> R {
    let latest = latest_of(world)?;
    let editor = latest.get("editor").cloned().unwrap_or(Value::Null);
    expect(
        editor.get("kind") == Some(&json!("FACILITATOR_PROXY"))
            && editor.get("displayName").is_none_or(Value::is_null),
        &format!("代理入力ではない: {editor}"),
    )
}

#[then(regex = r"^競合した入力 (\d+) は、応答に含まれない$")]
async fn conflicted_not_echoed(world: &mut ApiWorld, quantity: i64) -> R {
    let body = world.reply()?.body.clone();
    fn leaves(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::Object(m) => m.values().for_each(|x| leaves(x, out)),
            Value::Array(a) => a.iter().for_each(|x| leaves(x, out)),
            other @ (Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)) => {
                out.push(other.to_string());
            }
        }
    }
    let mut all = Vec::new();
    leaves(&body, &mut all);
    expect(
        !all.contains(&quantity.to_string()),
        &format!("競合した入力が含まれている: {body}"),
    )
}

#[then("保存が受け付けられる")]
async fn save_accepted(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 200,
        &format!("保存が受け付けられていない: {}", world.reply()?.body),
    )
}

#[then(regex = r"^当週の(工場|一次卸|二次卸|小売店)の入力は (\d+)、版は (\d+) である$")]
async fn role_has_decision_and_version(
    world: &mut ApiWorld,
    role: String,
    quantity: i64,
    version: i64,
) -> R {
    let state = facilitator_state(world).await?;
    let r = en(&role)?;
    expect(
        state.pointer(&format!("/roles/{r}/decision")) == Some(&json!(quantity))
            && state.pointer(&format!("/roles/{r}/decisionVersion")) == Some(&json!(version)),
        &format!("{role} の入力・版が違う: {state}"),
    )
}

#[given(regex = r"^共同担当の(.+)が、当週の数量をさらに (\d+) 回保存している$")]
async fn co_holder_saved_more(world: &mut ApiWorld, name: String, times: i64) -> R {
    for i in 0..times {
        save_now(world, &name, 10 + i).await?;
        expect(status(world)? == 200, "保存できない")?;
    }
    Ok(())
}

#[given(regex = r"^(.+)が、当週の数量をあと (\d+) 回保存している$")]
async fn holder_saved_more(world: &mut ApiWorld, name: String, times: i64) -> R {
    co_holder_saved_more(world, name, times).await
}

#[when(regex = r"^共同担当の(.+)が、当週の数量をもう 1 回保存しようとする$")]
async fn co_holder_tries_one_more(world: &mut ApiWorld, name: String) -> R {
    save_now(world, &name, 100).await
}

#[given(regex = r"^共同担当の(.+)が、当週の数量を (\d+) に保存し直している$")]
async fn co_holder_saved_again(world: &mut ApiWorld, name: String, quantity: i64) -> R {
    save_now(world, &name, quantity).await?;
    expect(
        status(world)? == 200,
        &format!("保存し直せない: {}", world.reply()?.body),
    )
}

#[given("進行役が、確定の確認画面を開いて、各役割の入力の版を控えている")]
async fn facilitator_remembers_basis(world: &mut ApiWorld) -> R {
    let state = facilitator_state(world).await?;
    let basis: serde_json::Map<String, Value> = ROLES
        .iter()
        .map(|(_, en)| {
            (
                (*en).to_owned(),
                state
                    .pointer(&format!("/roles/{en}/decisionVersion"))
                    .cloned()
                    .unwrap_or(json!(0)),
            )
        })
        .collect();
    world.remembered_basis = Some(Value::Object(basis));
    Ok(())
}

#[when(regex = r"^進行役が、控えた版のまま第 (\d+) 週を確定しようとする$")]
async fn commit_with_remembered(world: &mut ApiWorld, week: i64) -> R {
    let basis = world.remembered_basis.clone().ok_or("版を控えていない")?;
    let (id, cookie) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    let key = world.next_key();
    world
        .call(
            "POST",
            &format!("/api/v1/sessions/{id}/weeks/{week}/commit"),
            Some(&cookie),
            Some(&key),
            &json!({"requestedWeek": week, "basis": basis}).to_string(),
        )
        .await
        .map(|_| ())
}

#[then("確定の根拠にした入力が変わったという理由で拒否される")]
async fn rejected_decisions_changed(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 409 && code(world)? == "session.decisions_changed",
        &format!("根拠の変化の拒否ではない: {}", world.reply()?.body),
    )
}

#[then(
    regex = r"^現在の入力として、(工場|一次卸|二次卸|小売店)の (\d+)（保存者: (.+)）が示される$"
)]
async fn current_decision_shown(
    world: &mut ApiWorld,
    role: String,
    quantity: i64,
    editor: String,
) -> R {
    let entry = world
        .reply()?
        .body
        .pointer(&format!("/current/{}", en(&role)?))
        .cloned()
        .ok_or("current が無い")?;
    expect(
        entry.get("quantity") == Some(&json!(quantity))
            && entry.pointer("/editor/displayName") == Some(&json!(editor)),
        &format!("現在の入力・保存者が違う: {entry}"),
    )
}

#[then("確定の根拠が変わったという理由ではない")]
async fn not_decisions_changed(world: &mut ApiWorld) -> R {
    expect(
        code(world)? != "session.decisions_changed",
        "根拠の変化の理由になっている",
    )
}

// ---- 役割の入れ替え（AC3.2.5。開始後） ----

async fn assign_to(world: &mut ApiWorld, cookie: &str, pid: &str, role: &str) -> R {
    let (id, key) = (world.game()?.id.clone(), world.next_key());
    world
        .call(
            "PUT",
            &format!("/api/v1/games/{id}/participants/{pid}/role"),
            Some(cookie),
            Some(&key),
            &json!({"role": role}).to_string(),
        )
        .await
        .map(|_| ())
}

#[when(regex = r"^進行役が、(工場|一次卸|二次卸|小売店)の担当を(.+)に入れ替え(?:る|ようとする)$")]
async fn facilitator_replaces(world: &mut ApiWorld, role: String, name: String) -> R {
    let (old_pid, _) = world
        .game()?
        .players
        .get(en(&role)?)
        .cloned()
        .ok_or("参加者が無い")?;
    let (pid, cookie) = world
        .game()?
        .named
        .get(name.trim())
        .cloned()
        .ok_or("参加者が無い")?;
    let facilitator = world.game()?.facilitator.clone();
    assign_to(world, &facilitator, &pid, en(&role)?).await?;
    if status(world)? == 200 {
        world.replaced = Some(old_pid);
        // 「最新の状況」は、役割を引き継いだ新担当者から見た状況
        world.recovered = Some((cookie, pid));
    }
    Ok(())
}

#[when(
    regex = r"^(工場|一次卸|二次卸|小売店)の参加者が、(工場|一次卸|二次卸|小売店)の担当を(.+)に入れ替えようとする$"
)]
async fn participant_tries_to_replace(
    world: &mut ApiWorld,
    actor: String,
    role: String,
    name: String,
) -> R {
    let (_, cookie, _) = holder(world, &format!("{actor}の参加者")).await?;
    let (pid, _) = world
        .game()?
        .named
        .get(name.trim())
        .cloned()
        .ok_or("参加者が無い")?;
    assign_to(world, &cookie, &pid, en(&role)?).await
}

#[when(
    regex = r"^進行役が、(工場|一次卸|二次卸|小売店)の参加者を(工場|一次卸|二次卸|小売店)に割り当て(?:直す|ようとする)$"
)]
async fn facilitator_reassigns(world: &mut ApiWorld, current: String, role: String) -> R {
    let id = world.game()?.id.clone();
    world.history_size = sqlx::query_scalar("SELECT count(*) FROM events WHERE game_id = $1::uuid")
        .bind(&id)
        .fetch_one(world.pool()?)
        .await
        .map_err(|e| e.to_string())?;
    let (pid, _) = world
        .game()?
        .players
        .get(en(&current)?)
        .cloned()
        .ok_or("参加者が無い")?;
    let facilitator = world.game()?.facilitator.clone();
    assign_to(world, &facilitator, &pid, en(&role)?).await
}

#[given(regex = r"^進行役が、([^の]+)の資格を失効させている$")]
async fn facilitator_revoked_named(world: &mut ApiWorld, name: String) -> R {
    let (pid, _) = world
        .game()?
        .named
        .get(name.trim())
        .cloned()
        .ok_or("参加者が無い")?;
    revoke(world, &pid).await
}

#[then("割り当ては受け付けられるが、履歴に何も足されない")]
async fn assigned_without_history(world: &mut ApiWorld) -> R {
    let id = world.game()?.id.clone();
    let size: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE game_id = $1::uuid")
        .bind(&id)
        .fetch_one(world.pool()?)
        .await
        .map_err(|e| e.to_string())?;
    expect(
        status(world)? == 200 && size == world.history_size,
        &format!(
            "履歴が増えた、または拒否された: {} → {size}",
            world.history_size
        ),
    )
}

#[then("権限エラーになる")]
async fn permission_denied(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 403 && code(world)? == "app.unauthorized",
        &format!("権限エラーではない: {}", world.reply()?.body),
    )
}

#[then("準備中でないという理由で、割り当ては拒否される")]
async fn assign_rejected_not_preparing(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 409 && code(world)? == "game.not_preparing",
        &format!("準備中でない拒否ではない: {}", world.reply()?.body),
    )
}

#[then(regex = r"^(工場|一次卸|二次卸|小売店)の参加者の資格は、失効していない$")]
async fn credential_not_revoked(world: &mut ApiWorld, role: String) -> R {
    credential_remains(world, role).await
}

#[then(regex = r"^(.+)が(工場|一次卸|二次卸|小売店)の担当になる$")]
async fn becomes_holder(world: &mut ApiWorld, name: String, role: String) -> R {
    expect(status(world)? == 200, "入れ替えられていない")?;
    let (_, cookie) = world
        .game()?
        .named
        .get(name.trim())
        .cloned()
        .ok_or("参加者が無い")?;
    let id = world.game()?.id.clone();
    world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await?;
    expect(
        status(world)? == 200 && world.reply()?.body.get("role") == Some(&json!(en(&role)?)),
        &format!("役割が違う: {}", world.reply()?.body),
    )
}

async fn old_holder_cannot_use(world: &mut ApiWorld, pid: &str, cookie: &str) -> R {
    let recovery = world
        .game()?
        .recoveries
        .get(pid)
        .cloned()
        .ok_or("復帰資格が無い")?;
    recover_with(world, &recovery, false, None).await?;
    expect(
        status(world)? == 403 && world.reply()?.cookie.is_none(),
        "復帰できてしまう",
    )?;
    let id = world.game()?.id.clone();
    world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/state"),
            Some(cookie),
            None,
            "",
        )
        .await?;
    expect(status(world)? == 403, "以前のブラウザセッションが使える")
}

#[then(regex = r"^以前の(工場|一次卸|二次卸|小売店)の参加者の資格は、自動で失効している$")]
async fn replaced_revoked(world: &mut ApiWorld, role: String) -> R {
    let pid = world
        .replaced
        .clone()
        .ok_or("入れ替えられた参加者がいない")?;
    let (_, cookie) = world
        .game()?
        .players
        .get(en(&role)?)
        .cloned()
        .ok_or("参加者が無い")?;
    old_holder_cannot_use(world, &pid, &cookie).await
}

#[then(regex = r"^共同担当だった(.+)の資格も、自動で失効している$")]
async fn co_holder_revoked(world: &mut ApiWorld, name: String) -> R {
    let (pid, cookie) = world
        .game()?
        .named
        .get(name.trim())
        .cloned()
        .ok_or("参加者が無い")?;
    old_holder_cannot_use(world, &pid, &cookie).await
}

#[then(regex = r"^(.+)は、第 (\d+) 週の数量として (\d+) を保存できる$")]
async fn named_can_save(world: &mut ApiWorld, name: String, week: i64, quantity: i64) -> R {
    let (_, cookie, role) = holder(world, &name).await?;
    let state = facilitator_state(world).await?;
    let version = state
        .pointer(&format!("/roles/{role}/decisionVersion"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let (id, key) = (world.game()?.id.clone(), world.next_key());
    world.if_match = Some(version.to_string());
    world
        .call(
            "PUT",
            &format!("/api/v1/sessions/{id}/decisions"),
            Some(&cookie),
            Some(&key),
            &json!({"week": week, "quantity": quantity}).to_string(),
        )
        .await?;
    expect(
        status(world)? == 200,
        &format!("保存できない: {}", world.reply()?.body),
    )
}

#[then(
    regex = r"^(工場|一次卸|二次卸|小売店)の入力 (\d+) の入力者は、以前の(?:工場|一次卸|二次卸|小売店)の参加者として残っている$"
)]
async fn editor_label_remains(world: &mut ApiWorld, role: String, quantity: i64) -> R {
    let old = world
        .replaced
        .clone()
        .ok_or("入れ替えられた参加者がいない")?;
    let id = world.game()?.id.clone();
    let (q, editor): (i64, String) = sqlx::query_as(
        "SELECT (payload->>'quantity')::bigint, payload->'editor'->>'id' FROM events \
         WHERE game_id = $1::uuid AND event_type = 'DecisionSaved' AND payload->>'role' = $2 \
         ORDER BY seq DESC LIMIT 1",
    )
    .bind(&id)
    .bind(en(&role)?)
    .fetch_one(world.pool()?)
    .await
    .map_err(|e| e.to_string())?;
    expect(
        q == quantity && editor == old,
        &format!("入力者が以前の担当者として残っていない: {q} {editor}"),
    )
}

#[given(regex = r"^(.+)の参加者が、識別子つきで第 (\d+) 週の数量として (\d+) を保存している$")]
async fn saved_with_identifier(world: &mut ApiWorld, role: String, week: i64, quantity: i64) -> R {
    saved_with_key(world, role, week, quantity).await
}

#[then(regex = r"^以前の(.+)の参加者が、同じ識別子で同じ保存を再送すると、権限エラーになる$")]
async fn former_holder_resends(world: &mut ApiWorld, role: String) -> R {
    save_keyed(world, &role, 1, 4).await?;
    permission_denied(world).await?;
    stored_response_not_returned(world).await
}

// ---- カスタム条件（AC1.1.3〜1.1.5） ----

const ROLE_LABELS: [&str; 4] = ["小売店", "二次卸", "一次卸", "工場"];

/// 「条件の呼び名」と、`conditions` の項目名。
fn condition_name(label: &str) -> Result<&'static str, String> {
    Ok(match label {
        "初期の流れ" => "initialFlow",
        "注文の遅延" => "orderDelayWeeks",
        "配送の遅延" => "shipmentDelayWeeks",
        "生産の遅延" => "productionDelayWeeks",
        "在庫の単価" => "holdingCostMinor",
        "受注残の単価" => "backlogCostMinor",
        "公開範囲" => "disclosurePolicy",
        other => return Err(format!("知らない条件: {other}")),
    })
}

/// 変更した項目の呼び名と、API の値。
fn field_value(label: &str) -> Result<&'static str, String> {
    Ok(match label {
        "初期在庫" => "INITIAL_INVENTORY",
        "初期の流れ" => "INITIAL_FLOW",
        "注文の遅延" => "ORDER_DELAY",
        "配送の遅延" => "SHIPMENT_DELAY",
        "生産の遅延" => "PRODUCTION_DELAY",
        "在庫の単価" => "HOLDING_COST",
        "受注残の単価" => "BACKLOG_COST",
        "公開範囲" => "DISCLOSURE",
        other => return Err(format!("知らない項目: {other}")),
    })
}

/// `小売店の初期在庫を 20、配送の遅延を 3 週` のような言い方を、`conditions` の JSON にする。
fn conditions_json(phrase: &str) -> Result<Value, String> {
    let mut conditions = serde_json::Map::new();
    let mut inventory = serde_json::Map::new();
    for part in phrase.split('、').map(str::trim).filter(|p| !p.is_empty()) {
        let (label, raw) = part
            .split_once('を')
            .ok_or_else(|| format!("条件の言い方が違う: {part}"))?;
        let value = raw
            .trim()
            .trim_end_matches('週')
            .trim()
            .trim_matches(|c| c == '「' || c == '」');
        let role_label = ROLE_LABELS
            .iter()
            .find(|r| label == format!("{r}の初期在庫"));
        if let Some(role_label) = role_label {
            inventory.insert(
                en(role_label)?.to_owned(),
                json!(value.parse::<i64>().map_err(|e| e.to_string())?),
            );
        } else {
            let name = condition_name(label)?;
            let json_value = if name == "disclosurePolicy" {
                json!(match value {
                    "なし" => "NONE",
                    "チーム合計" => "TEAM_TOTAL",
                    other => other,
                })
            } else {
                json!(value.parse::<i64>().map_err(|e| e.to_string())?)
            };
            conditions.insert(name.to_owned(), json_value);
        }
    }
    if !inventory.is_empty() {
        conditions.insert("initialInventory".to_owned(), Value::Object(inventory));
    }
    Ok(Value::Object(conditions))
}

fn custom_body(phrase: &str, kind: &str) -> Result<Value, String> {
    Ok(
        json!({"kind": kind, "finalWeek": 12, "demand": kit_demand(12), "conditions": conditions_json(phrase)?}),
    )
}

#[when(regex = r"^進行役が、(.+)に変えて、ゲームを作成(?:する|しようとする)$")]
async fn create_custom(world: &mut ApiWorld, phrase: String) -> R {
    let body = custom_body(&phrase, "CUSTOM")?;
    world.create_with(&body).await.map(|_| ())
}

#[given(regex = r"^進行役が、(.+)に変えて、ゲームを作成している$")]
async fn created_custom(world: &mut ApiWorld, phrase: String) -> R {
    let body = custom_body(&phrase, "CUSTOM")?;
    let reply = world.create_with(&body).await?;
    expect(
        reply.status == 201,
        &format!("作成できない: {}", reply.body),
    )
}

#[when("進行役が、キットの値のままの条件を指定して、ゲームをカスタムで作成する")]
async fn create_custom_with_kit_values(world: &mut ApiWorld) -> R {
    let body = custom_body(
        "初期の流れを 4、注文の遅延を 2、配送の遅延を 2、生産の遅延を 2、在庫の単価を 50、受注残の単価を 100、公開範囲を チーム合計",
        "CUSTOM",
    )?;
    world.create_with(&body).await.map(|_| ())
}

#[when("進行役が、キット準拠の作成に、配送の遅延 3 週の条件を付けて作成しようとする")]
async fn create_kit_with_conditions(world: &mut ApiWorld) -> R {
    let body = custom_body("配送の遅延を 3 週", "KIT")?;
    world.create_with(&body).await.map(|_| ())
}

#[when(regex = r"^進行役が、最終週 (\d+) の設定でゲームを作成しようとする$")]
async fn create_with_final_week(world: &mut ApiWorld, final_week: usize) -> R {
    world
        .create_game(
            i64::try_from(final_week).map_err(|e| e.to_string())?,
            &kit_demand(final_week),
        )
        .await
        .map(|_| ())
}

#[then("ゲームが作成される")]
async fn game_is_created(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 201 && world.games.len() == 1,
        &format!("作成されていない: {}", world.reply()?.body),
    )
}

async fn settings_of_created(world: &mut ApiWorld) -> Result<(String, Vec<String>), String> {
    let (id, cookie) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    let body = world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await?
        .body;
    let kind = body
        .get("settingsKind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut changes: Vec<String> = body
        .get("changedSettings")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    changes.sort();
    Ok((kind, changes))
}

#[then(regex = r"^ゲームの設定の種別は「カスタム」で、変更した項目は(.+)である$")]
async fn kind_is_custom(world: &mut ApiWorld, labels: String) -> R {
    let mut expected: Vec<String> = labels
        .split('」')
        .filter_map(|part| part.split_once('「').map(|(_, label)| label))
        .map(|label| field_value(label).map(str::to_owned))
        .collect::<Result<_, _>>()?;
    expected.sort();
    let (kind, changes) = settings_of_created(world).await?;
    expect(
        kind == "CUSTOM" && changes == expected,
        &format!("種別・変更した項目が違う: {kind} {changes:?}（期待 {expected:?}）"),
    )
}

#[then("ゲームの設定の種別は「キット準拠」で、変更した項目は無い")]
async fn kind_is_kit(world: &mut ApiWorld) -> R {
    let (kind, changes) = settings_of_created(world).await?;
    expect(
        kind == "KIT" && changes.is_empty(),
        &format!("キット準拠ではない: {kind} {changes:?}"),
    )
}

fn error_list(world: &ApiWorld) -> Result<Vec<Value>, String> {
    Ok(world
        .reply()?
        .body
        .get("errors")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// 誤りの項目名（`conditions.` の接頭辞と、役割の添え字を除く）。
fn error_target(error: &Value) -> String {
    error
        .get("field")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim_start_matches("conditions.")
        .split('.')
        .next()
        .unwrap_or_default()
        .to_owned()
}

#[then("誤りの対象は「条件」であり、カスタムで作成するという修正内容が示される")]
async fn error_says_use_custom(world: &mut ApiWorld) -> R {
    let errors = error_list(world)?;
    let found = errors
        .iter()
        .find(|e| e.get("field") == Some(&json!("conditions")));
    expect(
        found.is_some_and(|e| {
            e.get("message")
                .and_then(Value::as_str)
                .is_some_and(|m| m.contains("カスタム") || m.contains("CUSTOM"))
        }),
        &format!("条件の誤りが無い: {errors:?}"),
    )
}

#[then(regex = r"^誤りの対象は「([^」]+)」であり、「([^」]+)」にするという修正内容が示される$")]
async fn error_points_at(world: &mut ApiWorld, name: String, correction: String) -> R {
    expect(status(world)? == 422, "拒否されていない")?;
    let errors = error_list(world)?;
    let found = errors.iter().find(|e| error_target(e) == name);
    let norm = |s: &str| s.replace(' ', "");
    expect(
        found.is_some_and(|e| {
            e.get("message")
                .and_then(Value::as_str)
                .is_some_and(|m| norm(m).contains(&norm(&correction)))
        }),
        &format!("「{name}」「{correction}」を示す誤りが無い: {errors:?}"),
    )
}

#[then(regex = r"^誤りの対象として「([^」]+)」と「([^」]+)」の両方が示される$")]
async fn both_errors_shown(world: &mut ApiWorld, first: String, second: String) -> R {
    expect(status(world)? == 422, "拒否されていない")?;
    let targets: Vec<String> = error_list(world)?.iter().map(error_target).collect();
    expect(
        targets.contains(&first) && targets.contains(&second),
        &format!("両方が示されていない: {targets:?}"),
    )
}

#[then("最終週は 1 以上 50 以下の整数にするという修正内容が示される")]
async fn final_week_correction_shown(world: &mut ApiWorld) -> R {
    expect(status(world)? == 422, "拒否されていない")?;
    let ok = error_list(world)?.iter().any(|e| {
        e.get("message")
            .and_then(Value::as_str)
            .is_some_and(|m| m.contains('1') && m.contains("50") && m.contains("整数"))
    });
    expect(ok, "最終週の修正内容が示されていない")
}

#[then(regex = r"^小売店の第 (\d+) 週の在庫は (\d+) である$")]
async fn retailer_inventory(world: &mut ApiWorld, week: i64, inventory: i64) -> R {
    fetch_state(world, "小売店", "").await?;
    let body = world.reply()?.body.clone();
    expect(
        body.get("week") == Some(&json!(week))
            && body.pointer("/roleStatus/inventory") == Some(&json!(inventory)),
        &format!("在庫・週が違う: {body}"),
    )
}

// ---- 自動確定（AC1.1.6・US2.4） ----

fn commit_mode_body(mode: &str) -> Value {
    json!({"kind": "KIT", "finalWeek": 12, "demand": kit_demand(12), "commitMode": mode})
}

#[given("進行役が、自動確定を有効にして、ゲームを作成している")]
async fn created_with_auto(world: &mut ApiWorld) -> R {
    let reply = world.create_with(&commit_mode_body("AUTO")).await?;
    expect(
        reply.status == 201,
        &format!("作成できない: {}", reply.body),
    )
}

#[when("進行役が、自動確定を有効にして、ゲームを作成する")]
async fn create_with_auto(world: &mut ApiWorld) -> R {
    world
        .create_with(&commit_mode_body("AUTO"))
        .await
        .map(|_| ())
}

#[when(regex = r"^進行役が、確定方式「(.+)」で、ゲームを作成しようとする$")]
async fn create_with_commit_mode(world: &mut ApiWorld, mode: String) -> R {
    world
        .create_with(&commit_mode_body(&mode))
        .await
        .map(|_| ())
}

#[then(regex = r"^ゲームの確定方式は「(手動確定|自動確定)」である$")]
async fn commit_mode_is(world: &mut ApiWorld, label: String) -> R {
    let (id, cookie) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    let body = world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await?
        .body;
    let expected = if label == "自動確定" {
        "AUTO"
    } else {
        "MANUAL"
    };
    expect(
        body.get("commitMode") == Some(&json!(expected)),
        &format!("確定方式が違う: {body}"),
    )
}

#[then("誤りの対象は「commitMode」であり、MANUAL か AUTO にするという修正内容が示される")]
async fn commit_mode_error_shown(world: &mut ApiWorld) -> R {
    expect(status(world)? == 422, "拒否されていない")?;
    let ok = error_list(world)?.iter().any(|e| {
        e.get("field") == Some(&json!("commitMode"))
            && e.get("message")
                .and_then(Value::as_str)
                .is_some_and(|m| m.contains("MANUAL") && m.contains("AUTO"))
    });
    expect(ok, "commitMode の修正内容が示されていない")
}

#[when(regex = r"^(.+)の参加者が、第 (\d+) 週の数量として (\d+) を保存する$")]
async fn participant_saves(world: &mut ApiWorld, role: String, week: i64, quantity: i64) -> R {
    save_in_week(world, &role, week, json!(quantity)).await?;
    expect(
        status(world)? == 200,
        &format!("保存できない: {}", world.reply()?.body),
    )
}

async fn change_commit_mode(world: &mut ApiWorld, cookie: &str, mode: &str) -> R {
    let (id, key) = (world.game()?.id.clone(), world.next_key());
    world
        .call(
            "PUT",
            &format!("/api/v1/sessions/{id}/commit-mode"),
            Some(cookie),
            Some(&key),
            &json!({"commitMode": mode}).to_string(),
        )
        .await
        .map(|_| ())
}

#[when(regex = r"^進行役が、自動確定を(有効|無効)にする$")]
async fn facilitator_changes_commit_mode(world: &mut ApiWorld, which: String) -> R {
    let cookie = world.game()?.facilitator.clone();
    change_commit_mode(
        world,
        &cookie,
        if which == "有効" { "AUTO" } else { "MANUAL" },
    )
    .await?;
    expect(
        status(world)? == 200,
        &format!("確定方式を変えられない: {}", world.reply()?.body),
    )
}

#[when(regex = r"^(.+)の参加者が、自動確定を無効にしようとする$")]
async fn participant_tries_to_disable(world: &mut ApiWorld, role: String) -> R {
    let (_, cookie, _) = holder(world, &format!("{role}の参加者")).await?;
    change_commit_mode(world, &cookie, "MANUAL").await
}

// ---- 観察者（US1.3・US4.1） ----

async fn invite_with(world: &mut ApiWorld, cookie: Option<String>) -> R {
    let id = world.game()?.id.clone();
    let key = world.next_key();
    let reply = world
        .call(
            "POST",
            &format!("/api/v1/games/{id}/observer-invitations"),
            cookie.as_deref(),
            Some(&key),
            "{}",
        )
        .await?;
    if reply.status == 200 {
        let invitation = reply.body.get("invitationId").and_then(Value::as_str);
        let code = reply.body.get("invitationCode").and_then(Value::as_str);
        if let (Some(i), Some(c)) = (invitation, code) {
            world.invitation = Some((i.to_owned(), c.to_owned()));
        }
    }
    Ok(())
}

#[given("進行役が観察用の招待を発行している")]
async fn invitation_issued(world: &mut ApiWorld) -> R {
    let cookie = world.game()?.facilitator.clone();
    invite_with(world, Some(cookie)).await?;
    expect(
        status(world)? == 200,
        &format!("招待を発行できない: {}", world.reply()?.body),
    )
}

#[when("進行役が観察用の招待を求める")]
async fn facilitator_invites(world: &mut ApiWorld) -> R {
    let cookie = world.game()?.facilitator.clone();
    invite_with(world, Some(cookie)).await
}

#[when(regex = r"^(工場|一次卸|二次卸|小売店)の参加者が観察用の招待を求める$")]
async fn participant_invites(world: &mut ApiWorld, role: String) -> R {
    let (_, cookie, _) = holder(world, &format!("{role}の参加者")).await?;
    invite_with(world, Some(cookie)).await
}

#[when("資格の無い人が観察用の招待を求める")]
async fn anonymous_invites(world: &mut ApiWorld) -> R {
    invite_with(world, None).await
}

#[when("観察者が、観察用の招待を求める")]
async fn observer_invites(world: &mut ApiWorld) -> R {
    let cookie = world.observer_cookie.clone();
    invite_with(world, cookie).await
}

async fn revoke_invitation(world: &mut ApiWorld, cookie: Option<String>) -> R {
    let (invitation, _) = world.invitation.clone().ok_or("招待が無い")?;
    let (id, key) = (world.game()?.id.clone(), world.next_key());
    world
        .call(
            "POST",
            &format!("/api/v1/games/{id}/observer-invitations/{invitation}/revoke"),
            cookie.as_deref(),
            Some(&key),
            "",
        )
        .await
        .map(|_| ())
}

#[given("進行役が、その観察用の招待を失効させている")]
async fn invitation_revoked(world: &mut ApiWorld) -> R {
    let cookie = world.game()?.facilitator.clone();
    revoke_invitation(world, Some(cookie)).await?;
    expect(
        status(world)? == 200,
        &format!("失効できない: {}", world.reply()?.body),
    )
}

#[when(regex = r"^(工場|一次卸|二次卸|小売店)の参加者が、その観察用の招待を失効させようとする$")]
async fn participant_revokes_invitation(world: &mut ApiWorld, role: String) -> R {
    let (_, cookie, _) = holder(world, &format!("{role}の参加者")).await?;
    revoke_invitation(world, Some(cookie)).await
}

#[when("招待コードを参加コードとして使って、参加者が参加しようとする")]
async fn invite_code_as_join_code(world: &mut ApiWorld) -> R {
    let (_, code) = world.invitation.clone().ok_or("招待が無い")?;
    join_raw(world, &json!({"joinCode": code, "displayName": "紛れ込み"})).await
}

async fn observer_join(world: &mut ApiWorld, name: &str) -> R {
    let (_, code) = world.invitation.clone().ok_or("招待が無い")?;
    let key = world.next_key();
    let reply = world
        .call(
            "POST",
            "/api/v1/participations/observe",
            None,
            Some(&key),
            &json!({"invitationCode": code, "displayName": name}).to_string(),
        )
        .await?;
    if reply.status == 200 {
        world.observer_cookie = reply.cookie.clone();
    }
    Ok(())
}

#[when(regex = r"^観察者「(.+)」が、招待コードで参加(?:する|しようとする)$")]
async fn observer_joins(world: &mut ApiWorld, name: String) -> R {
    observer_join(world, &name).await
}

#[given(regex = r"^観察者「(.+)」が、招待コードで参加している$")]
async fn observer_has_joined(world: &mut ApiWorld, name: String) -> R {
    observer_join(world, &name).await?;
    expect(
        status(world)? == 200 && world.observer_cookie.is_some(),
        &format!("観察者として参加できない: {}", world.reply()?.body),
    )
}

#[then("観察用の招待コードが発行される")]
async fn code_issued(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 200
            && world
                .reply()?
                .body
                .get("invitationCode")
                .and_then(Value::as_str)
                .is_some_and(|c| !c.is_empty()),
        &format!("発行されていない: {}", world.reply()?.body),
    )
}

#[then("招待コードは参加コードと異なる")]
async fn code_differs_from_join_code(world: &mut ApiWorld) -> R {
    let join_code = world.game()?.join_code.clone();
    expect(
        world.reply()?.body.get("invitationCode") != Some(&json!(join_code)),
        "招待コードが参加コードと同じ",
    )
}

#[then("招待コードは含まれない")]
async fn no_invitation_code(world: &mut ApiWorld) -> R {
    expect(
        !world.reply()?.body.to_string().contains("invitationCode"),
        "招待コードが含まれている",
    )
}

#[then("招待が無効という理由で拒否される")]
async fn invitation_invalid_reason(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 403
            && code(world)? == "game.invitation_invalid"
            && world.reply()?.cookie.is_none(),
        &format!("招待が無効という拒否ではない: {}", world.reply()?.body),
    )
}

#[then("観察者として参加できる")]
async fn joined_as_observer(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 200
            && world.reply()?.body.get("kind") == Some(&json!("OBSERVER"))
            && world.reply()?.recovery.is_none(),
        &format!("観察者として参加できていない: {}", world.reply()?.body),
    )
}

async fn lobby_of_facilitator(world: &mut ApiWorld) -> Result<Value, String> {
    let (id, cookie) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    Ok(world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/lobby"),
            Some(&cookie),
            None,
            "",
        )
        .await?
        .body)
}

#[then(regex = r"^進行役のロビーに、観察者「(.+)」が役割なしで載る$")]
async fn lobby_has_observer(world: &mut ApiWorld, name: String) -> R {
    let lobby = lobby_of_facilitator(world).await?;
    let entry = lobby
        .get("observers")
        .and_then(Value::as_array)
        .and_then(|a| {
            a.iter()
                .find(|o| o.get("displayName") == Some(&json!(name)))
        })
        .cloned();
    expect(
        entry.is_some_and(|e| e.get("role").is_none()),
        &format!("ロビーに観察者が載っていない: {lobby}"),
    )
}

#[then("参加者の一覧に、観察者は含まれない")]
async fn participants_exclude_observer(world: &mut ApiWorld) -> R {
    let lobby = lobby_of_facilitator(world).await?;
    expect(
        lobby
            .get("participants")
            .and_then(Value::as_array)
            .map(Vec::len)
            == Some(4),
        "参加者が 4 人ではない",
    )
}

async fn observation_with(world: &mut ApiWorld, cookie: Option<String>) -> R {
    let id = world.game()?.id.clone();
    world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/observation"),
            cookie.as_deref(),
            None,
            "",
        )
        .await
        .map(|_| ())
}

#[when("観察者が観察画面を開く")]
async fn observer_opens_observation(world: &mut ApiWorld) -> R {
    let cookie = world.observer_cookie.clone();
    observation_with(world, cookie).await
}

#[when("進行役が観察画面を開く")]
async fn facilitator_opens_observation(world: &mut ApiWorld) -> R {
    let cookie = world.game()?.facilitator.clone();
    observation_with(world, Some(cookie)).await
}

#[when("資格の無い人が観察画面を開こうとする")]
async fn anonymous_opens_observation(world: &mut ApiWorld) -> R {
    observation_with(world, None).await
}

#[when(regex = r"^(工場|一次卸|二次卸|小売店)の参加者が観察画面を開こうとする$")]
async fn participant_opens_observation(world: &mut ApiWorld, role: String) -> R {
    let (_, cookie, _) = holder(world, &format!("{role}の参加者")).await?;
    observation_with(world, Some(cookie)).await
}

#[given(
    regex = r"^(工場|一次卸|二次卸|小売店)と(工場|一次卸|二次卸|小売店)の参加者が、第 (\d+) 週の入力を保存している$"
)]
async fn two_roles_saved(world: &mut ApiWorld, first: String, second: String, week: i64) -> R {
    for role in [first, second] {
        save_in_week(world, &role, week, json!(4)).await?;
        expect(status(world)? == 200, "保存できない")?;
    }
    Ok(())
}

#[then("観察画面の内容が返る")]
async fn observation_returned(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 200 && world.reply()?.body.get("totals").is_some(),
        &format!("観察画面の内容ではない: {}", world.reply()?.body),
    )
}

#[then(regex = r"^観察画面の現在週は (\d+) である$")]
async fn observation_week(world: &mut ApiWorld, week: i64) -> R {
    expect(
        world.reply()?.body.get("week") == Some(&json!(week)),
        &format!("現在週が違う: {}", world.reply()?.body),
    )
}

#[then(regex = r"^観察画面の入力済みの役割数は (\d+) である$")]
async fn observation_submitted(world: &mut ApiWorld, count: i64) -> R {
    expect(
        world.reply()?.body.get("submittedRoleCount") == Some(&json!(count)),
        &format!("入力済みの役割数が違う: {}", world.reply()?.body),
    )
}

#[then(regex = r"^観察画面に、第 (\d+) 週のチーム合計として、注文 (\d+)・在庫・受注残が含まれる$")]
async fn observation_totals(world: &mut ApiWorld, week: i64, order: i64) -> R {
    let entry = world
        .reply()?
        .body
        .pointer("/totals/weeks")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find(|w| w.get("week") == Some(&json!(week))))
        .cloned()
        .ok_or("第 N 週の合計が無い")?;
    expect(
        entry.get("order") == Some(&json!(order))
            && entry.get("inventory").is_some()
            && entry.get("backlog").is_some(),
        &format!("合計が違う: {entry}"),
    )
}

#[then("観察画面に、役割別の項目は含まれない")]
async fn no_role_specific(world: &mut ApiWorld) -> R {
    let text = world.reply()?.body.to_string();
    let leaked: Vec<&str> = [
        "FACTORY",
        "DISTRIBUTOR",
        "WHOLESALER",
        "RETAILER",
        "\"roles\"",
        "\"roleStatus\"",
        "\"results\"",
    ]
    .into_iter()
    .filter(|k| text.contains(k))
    .collect();
    expect(
        leaked.is_empty(),
        &format!("役割別の項目が含まれている: {leaked:?}"),
    )
}

#[then("観察画面にチーム合計は含まれず、公開されていないという理由が示される")]
async fn totals_not_disclosed(world: &mut ApiWorld) -> R {
    let totals = world
        .reply()?
        .body
        .get("totals")
        .cloned()
        .unwrap_or(Value::Null);
    expect(
        totals
            .get("weeks")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
            && totals.get("hiddenReason") == Some(&json!("DISCLOSURE_NONE")),
        &format!("合計が含まれている、または理由が無い: {totals}"),
    )
}

async fn observer_call(world: &mut ApiWorld, method: &str, path: &str, body: &str) -> R {
    let cookie = world.observer_cookie.clone();
    let key = world.next_key();
    world
        .call(method, path, cookie.as_deref(), Some(&key), body)
        .await
        .map(|_| ())
}

#[when(regex = r"^観察者が、(工場|一次卸|二次卸|小売店)の状況を取得しようとする$")]
async fn observer_fetches_role(world: &mut ApiWorld, role: String) -> R {
    let id = world.game()?.id.clone();
    observer_call(
        world,
        "GET",
        &format!("/api/v1/sessions/{id}/state?role={}", en(&role)?),
        "",
    )
    .await
}

#[when("観察者が、ゲームの状態を取得しようとする")]
async fn observer_fetches_game_state(world: &mut ApiWorld) -> R {
    let id = world.game()?.id.clone();
    observer_call(world, "GET", &format!("/api/v1/games/{id}/state"), "").await
}

#[when("観察者が、ロビーを取得しようとする")]
async fn observer_fetches_lobby(world: &mut ApiWorld) -> R {
    let id = world.game()?.id.clone();
    observer_call(world, "GET", &format!("/api/v1/games/{id}/lobby"), "").await
}

#[when(regex = r"^観察者が、(工場|一次卸|二次卸|小売店)の入力として (\d+) を保存しようとする$")]
async fn observer_saves(world: &mut ApiWorld, _role: String, quantity: i64) -> R {
    let id = world.game()?.id.clone();
    world.if_match = Some("0".to_owned());
    observer_call(
        world,
        "PUT",
        &format!("/api/v1/sessions/{id}/decisions"),
        &json!({"week": 1, "quantity": quantity}).to_string(),
    )
    .await
}

#[when(regex = r"^観察者が、第 (\d+) 週を確定しようとする$")]
async fn observer_commits(world: &mut ApiWorld, week: i64) -> R {
    let id = world.game()?.id.clone();
    let basis = json!({"FACTORY": 0, "DISTRIBUTOR": 0, "WHOLESALER": 0, "RETAILER": 0});
    observer_call(
        world,
        "POST",
        &format!("/api/v1/sessions/{id}/weeks/{week}/commit"),
        &json!({"requestedWeek": week, "basis": basis}).to_string(),
    )
    .await
}

#[when("観察者が、ゲームを一時停止しようとする")]
async fn observer_pauses(world: &mut ApiWorld) -> R {
    let id = world.game()?.id.clone();
    observer_call(world, "POST", &format!("/api/v1/sessions/{id}/pause"), "").await
}

#[when(regex = r"^観察者が、(工場|一次卸|二次卸|小売店)の参加者の資格を失効させようとする$")]
async fn observer_revokes_credential(world: &mut ApiWorld, role: String) -> R {
    let (pid, _, _) = holder(world, &format!("{role}の参加者")).await?;
    let id = world.game()?.id.clone();
    observer_call(
        world,
        "POST",
        &format!("/api/v1/games/{id}/credentials/revoke"),
        &json!({"subject": {"kind": "PARTICIPANT", "id": pid}}).to_string(),
    )
    .await
}

#[when(regex = r"^観察者が、自分に(工場|一次卸|二次卸|小売店)の役割を割り当てようとする$")]
async fn observer_assigns_self(world: &mut ApiWorld, role: String) -> R {
    let id = world.game()?.id.clone();
    observer_call(
        world,
        "PUT",
        &format!("/api/v1/games/{id}/participants/00000000-0000-4000-8000-000000000001/role"),
        &json!({"role": en(&role)?}).to_string(),
    )
    .await
}

#[when(regex = r"^観察者が振り返りを取得(?:する|しようとする)$")]
async fn observer_review(world: &mut ApiWorld) -> R {
    let id = world.game()?.id.clone();
    observer_call(world, "GET", &format!("/api/v1/games/{id}/review"), "").await
}

#[then("将来の需要は含まれない")]
async fn no_future_demand_in_reply(world: &mut ApiWorld) -> R {
    // キットの需要は一定（4）で、将来の需要の値そのものは、どの項目にも出てはならない
    let text = world.reply()?.body.to_string();
    expect(
        !text.contains("demand") && !text.contains("futureDemand"),
        "将来の需要が含まれている",
    )
}

#[then("参加コードは含まれない")]
async fn no_join_code_in_reply(world: &mut ApiWorld) -> R {
    let join_code = world.game()?.join_code.clone();
    expect(
        !world.reply()?.body.to_string().contains(&join_code),
        "参加コードが含まれている",
    )
}

// ---- 結果の出力（US4.3） ----

const CSV_COLUMNS: [&str; 14] = [
    "schema_version",
    "game_id",
    "settings_kind",
    "settings_changes",
    "commit_mode",
    "week",
    "role",
    "orders",
    "shipped",
    "ordered",
    "ending_inventory",
    "ending_backlog",
    "weekly_cost_minor",
    "cumulative_cost_minor",
];

/// CSV の列名と、JSON の `records` の項目名の対応（数量と費用の列）。
const VALUE_COLUMNS: [(&str, &str); 7] = [
    ("orders", "orders"),
    ("shipped", "shipped"),
    ("ordered", "ordered"),
    ("ending_inventory", "endingInventory"),
    ("ending_backlog", "endingBacklog"),
    ("weekly_cost_minor", "weeklyCostMinor"),
    ("cumulative_cost_minor", "cumulativeCostMinor"),
];

async fn export_with(
    world: &mut ApiWorld,
    format: Option<&str>,
    cookie: Option<String>,
) -> Result<Reply, String> {
    let id = world.game()?.id.clone();
    let query = format.map_or(String::new(), |f| format!("?format={f}"));
    world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/exports{query}"),
            cookie.as_deref(),
            None,
            "",
        )
        .await
}

#[when(regex = r"^進行役が結果を (CSV|JSON) で(?:も)?出力(する|しようとする)$")]
async fn facilitator_exports(world: &mut ApiWorld, format: String, kind: String) -> R {
    let cookie = world.game()?.facilitator.clone();
    let reply = export_with(world, Some(&format.to_lowercase()), Some(cookie)).await?;
    if kind == "する" {
        expect(
            reply.status == 200,
            &format!("出力できない: {}", reply.text),
        )?;
    }
    if format == "CSV" {
        world.export_csv = Some(reply);
    } else {
        world.export_json = Some(reply);
    }
    Ok(())
}

#[when(regex = r"^(工場|一次卸|二次卸|小売店)の参加者が結果を CSV で出力しようとする$")]
async fn participant_exports(world: &mut ApiWorld, role: String) -> R {
    let (_, cookie, _) = holder(world, &format!("{role}の参加者")).await?;
    export_with(world, Some("csv"), Some(cookie))
        .await
        .map(|_| ())
}

#[when("資格の無い人が結果を CSV で出力しようとする")]
async fn anonymous_exports(world: &mut ApiWorld) -> R {
    export_with(world, Some("csv"), None).await.map(|_| ())
}

#[when("進行役が、形式を指定せずに結果を出力しようとする")]
async fn export_without_format(world: &mut ApiWorld) -> R {
    let cookie = world.game()?.facilitator.clone();
    export_with(world, None, Some(cookie)).await.map(|_| ())
}

#[when(regex = r"^進行役が、形式「(.+)」で結果を出力しようとする$")]
async fn export_unknown_format(world: &mut ApiWorld, format: String) -> R {
    let cookie = world.game()?.facilitator.clone();
    export_with(world, Some(&format), Some(cookie))
        .await
        .map(|_| ())
}

fn is_download(reply: &Reply, content_type: &str, extension: &str, game_id: &str) -> R {
    let disposition = reply
        .headers
        .get("content-disposition")
        .cloned()
        .unwrap_or_default();
    expect(
        reply
            .headers
            .get("content-type")
            .is_some_and(|t| t.starts_with(content_type)),
        "種類が違う",
    )?;
    expect(
        disposition.starts_with("attachment")
            && disposition.contains(&format!("beer-game-{game_id}.{extension}")),
        &format!("ダウンロードの名前が付いていない: {disposition}"),
    )
}

#[then("出力は CSV として返り、ダウンロードの名前が付く")]
async fn csv_is_download(world: &mut ApiWorld) -> R {
    let id = world.game()?.id.clone();
    is_download(
        world.export_csv.as_ref().ok_or("CSV が無い")?,
        "text/csv",
        "csv",
        &id,
    )
}

#[then("出力は JSON として返り、ダウンロードの名前が付く")]
async fn json_is_download(world: &mut ApiWorld) -> R {
    let id = world.game()?.id.clone();
    is_download(
        world.export_json.as_ref().ok_or("JSON が無い")?,
        "application/json",
        "json",
        &id,
    )
}

/// CSV を、見出しと、列名 → 値の行にする（引用・`'` を含まない前提の単純な分割。出力はキット・カスタムの固定値）。
fn csv_rows(text: &str) -> (Vec<String>, Vec<BTreeMap<String, String>>) {
    let mut lines = text.split("\r\n").filter(|l| !l.is_empty());
    let header: Vec<String> = lines
        .next()
        .map(|l| l.split(',').map(str::to_owned).collect())
        .unwrap_or_default();
    let rows = lines
        .map(|line| {
            header
                .iter()
                .cloned()
                .zip(line.split(',').map(str::to_owned))
                .collect()
        })
        .collect();
    (header, rows)
}

#[then(
    regex = r"^CSV に、設定の種別「キット準拠」と、4 役割のそれぞれについて (\d+) 週分の受注・出荷・発注・在庫・受注残・費用が含まれる$"
)]
async fn csv_has_everything(world: &mut ApiWorld, weeks: usize) -> R {
    let id = world.game()?.id.clone();
    let reply = world.export_csv.as_ref().ok_or("CSV が無い")?;
    let (header, rows) = csv_rows(&reply.text);
    expect(header == CSV_COLUMNS, &format!("列が違う: {header:?}"))?;
    expect(
        rows.len() == weeks * 4,
        &format!("行数が違う: {}", rows.len()),
    )?;
    expect(
        rows.iter().all(|r| {
            r.get("settings_kind").map(String::as_str) == Some("KIT")
                && r.get("game_id") == Some(&id)
        }),
        "種別・ゲームの ID が違う行がある",
    )?;
    for (_, role) in ROLES {
        let mut found: Vec<usize> = rows
            .iter()
            .filter(|r| r.get("role").map(String::as_str) == Some(role))
            .filter_map(|r| r.get("week").and_then(|w| w.parse().ok()))
            .collect();
        found.sort_unstable();
        expect(
            found == (1..=weeks).collect::<Vec<_>>(),
            &format!("{role} の週が不足"),
        )?;
    }
    expect(
        rows.iter().all(|r| {
            VALUE_COLUMNS
                .iter()
                .all(|(c, _)| r.get(*c).is_some_and(|v| v.parse::<i64>().is_ok()))
        }),
        "数値でない値がある",
    )
}

fn json_of(reply: &Reply) -> Result<Value, String> {
    serde_json::from_str(&reply.text).map_err(|e| e.to_string())
}

#[then(
    regex = r"^JSON に、設定の種別「キット準拠」と、4 役割のそれぞれについて (\d+) 週分の受注・出荷・発注・在庫・受注残・費用が含まれる$"
)]
async fn json_has_everything(world: &mut ApiWorld, weeks: usize) -> R {
    let id = world.game()?.id.clone();
    let body = json_of(world.export_json.as_ref().ok_or("JSON が無い")?)?;
    expect(
        body.get("gameId") == Some(&json!(id))
            && body.pointer("/settings/kind") == Some(&json!("KIT")),
        "ゲームの ID・種別が違う",
    )?;
    let records = body
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    expect(records.len() == weeks * 4, "記録の数が違う")?;
    expect(
        records
            .iter()
            .all(|r| VALUE_COLUMNS.iter().all(|(_, f)| r.get(*f).is_some())),
        "項目が不足している記録がある",
    )
}

#[then("JSON に、設定の種別「カスタム」と、変更した項目「初期在庫」「配送の遅延」が含まれる")]
async fn json_is_custom(world: &mut ApiWorld) -> R {
    let body = json_of(world.export_json.as_ref().ok_or("JSON が無い")?)?;
    let mut changes: Vec<String> = body
        .pointer("/settings/changes")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    changes.sort();
    expect(
        body.pointer("/settings/kind") == Some(&json!("CUSTOM"))
            && changes == ["INITIAL_INVENTORY", "SHIPMENT_DELAY"],
        &format!("種別・変更した項目が違う: {body}"),
    )
}

#[then("2 つの形式の数量と費用が、週と役割ごとにすべて一致する")]
async fn values_match(world: &mut ApiWorld) -> R {
    let (_, rows) = csv_rows(&world.export_csv.as_ref().ok_or("CSV が無い")?.text);
    let body = json_of(world.export_json.as_ref().ok_or("JSON が無い")?)?;
    let records = body
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    expect(rows.len() == records.len(), "件数が違う")?;
    for row in &rows {
        let record = records
            .iter()
            .find(|r| {
                r.get("week").map(Value::to_string) == row.get("week").cloned()
                    && r.get("role").and_then(Value::as_str) == row.get("role").map(String::as_str)
            })
            .ok_or("対応する記録が無い")?;
        for (column, field) in VALUE_COLUMNS {
            expect(
                record.get(field).map(Value::to_string) == row.get(column).cloned(),
                &format!("{column} が違う"),
            )?;
        }
    }
    Ok(())
}

#[then("2 つの形式に、同じスキーマ版が記録される")]
async fn same_schema_version(world: &mut ApiWorld) -> R {
    let csv = world.export_csv.as_ref().ok_or("CSV が無い")?;
    let json = world.export_json.as_ref().ok_or("JSON が無い")?;
    let (_, rows) = csv_rows(&csv.text);
    let from_json = json_of(json)?
        .get("schemaVersion")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    expect(
        !from_json.is_empty()
            && rows
                .iter()
                .all(|r| r.get("schema_version") == Some(&from_json))
            && [csv, json]
                .iter()
                .all(|r| r.headers.get("x-export-schema-version") == Some(&from_json)),
        "スキーマ版が違う",
    )
}

#[then("出力の本文の SHA-256 が、チェックサムのヘッダーと一致する")]
async fn checksum_matches(world: &mut ApiWorld) -> R {
    for reply in [
        world.export_csv.as_ref().ok_or("CSV が無い")?,
        world.export_json.as_ref().ok_or("JSON が無い")?,
    ] {
        let expected: String = sqlx::query_scalar("SELECT encode(sha256($1::bytea), 'hex')")
            .bind(reply.text.as_bytes())
            .fetch_one(world.pool()?)
            .await
            .map_err(|e| e.to_string())?;
        expect(
            reply.headers.get("x-export-checksum") == Some(&format!("sha256-{expected}")),
            "チェックサムが一致しない",
        )?;
    }
    Ok(())
}

#[then("出力に、参加者の表示名と参加コードは含まれない")]
async fn export_has_no_private_values(world: &mut ApiWorld) -> R {
    let join_code = world.game()?.join_code.clone();
    let names: Vec<String> = world.game()?.named.keys().cloned().collect();
    for reply in [
        world.export_csv.as_ref().ok_or("CSV が無い")?,
        world.export_json.as_ref().ok_or("JSON が無い")?,
    ] {
        expect(!reply.text.contains(&join_code), "参加コードが含まれている")?;
        expect(
            names.iter().all(|n| !reply.text.contains(n.as_str())),
            "表示名が含まれている",
        )?;
    }
    Ok(())
}

#[then("出力の本文は返らない")]
async fn no_export_body(world: &mut ApiWorld) -> R {
    let reply = world.reply()?;
    expect(
        reply.status != 200
            && reply
                .headers
                .get("content-type")
                .is_some_and(|t| t.contains("problem"))
            && !reply.text.contains("schema_version"),
        "出力が返っている",
    )
}

#[then("形式の誤りとして拒否される")]
async fn format_rejected(world: &mut ApiWorld) -> R {
    expect(
        status(world)? == 422
            && error_list(world)?
                .iter()
                .any(|e| e.get("field") == Some(&json!("format"))),
        "形式の誤りではない",
    )
}
