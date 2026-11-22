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
    let version = world.game()?.versions.get(role).copied().unwrap_or(0);
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
