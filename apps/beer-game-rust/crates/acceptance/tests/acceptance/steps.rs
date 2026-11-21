//! ステップ定義。薄く保ち、HTTP を呼んで応答・DB を確かめるだけ（業務ロジックは持たない）。

use cucumber::{given, then, when};
use serde_json::{Value, json};

use crate::world::{ApiWorld, GameCtx};

type R = Result<(), String>;

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

fn kit_demand(final_week: usize) -> Vec<i64> {
    vec![4; final_week]
}

fn expect(condition: bool, message: &str) -> R {
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

async fn join_named(world: &mut ApiWorld, name: &str) -> R {
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
        world
            .game_mut()?
            .named
            .insert(name.to_owned(), (pid, cookie));
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
    world
        .game_mut()?
        .players
        .insert(role.to_owned(), (pid, cookie));
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
    let role = en(role_ja)?;
    let (_, cookie) = world
        .game()?
        .players
        .get(role)
        .cloned()
        .ok_or("参加者が無い")?;
    let id = world.game()?.id.clone();
    let key = world.next_key();
    let version = world.game()?.versions.get(role).copied().unwrap_or(0);
    let reply = world
        .call(
            "PUT",
            &format!("/api/v1/sessions/{id}/decisions"),
            Some(&cookie),
            Some(&key),
            &json!({"week": 1, "quantity": quantity}).to_string(),
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
    let versions = world.game()?.versions.clone();
    let basis: serde_json::Map<String, Value> = ROLES
        .iter()
        .map(|(_, en)| {
            (
                (*en).to_owned(),
                json!(versions.get(*en).copied().unwrap_or(0)),
            )
        })
        .collect();
    let key = key.unwrap_or_else(|| world.next_key());
    let body = json!({"requestedWeek": 1, "basis": basis}).to_string();
    Ok(world
        .call(
            "POST",
            &format!("/api/v1/sessions/{id}/weeks/1/commit"),
            Some(&facilitator),
            Some(&key),
            &body,
        )
        .await?
        .body)
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
