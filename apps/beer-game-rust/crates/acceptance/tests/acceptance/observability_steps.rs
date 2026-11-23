//! 構造化ログ・セキュリティヘッダー・生存の確認（AC6.1.1・AC6.1.4・X-3・X-5）のステップ。
//! ログは、本番と同じ形式（JSON 行）を、プロセスの中で捕捉したもの。**全シナリオの分が混ざる**ので、このシナリオの秘密が
//! 含まれないことを検査する（他のシナリオの値は関係しない）。

use beergame_app::log_capture::{capture_logs, captured_logs};
use cucumber::{then, when};
use serde_json::Value;

use crate::steps::{R, expect};
use crate::world::ApiWorld;

/// このシナリオの、秘密・表示名・非公開の値（資格・参加コード・復帰コード・表示名）。
fn secrets(world: &ApiWorld) -> Result<Vec<String>, String> {
    let game = world.game()?;
    let mut all = vec![
        game.facilitator.clone(),
        game.join_code.clone(),
        game.recovery.clone(),
    ];
    for (cookie_name, (_, cookie)) in &game.named {
        all.push(cookie_name.clone());
        all.push(cookie.clone());
    }
    for (_, (_, cookie)) in &game.players {
        all.push(cookie.clone());
    }
    all.extend(game.recoveries.values().cloned());
    // Cookie は `名前=値`。値だけも、秘密として探す
    let values: Vec<String> = all
        .iter()
        .filter_map(|c| c.split_once('=').map(|(_, v)| v.to_owned()))
        .collect();
    all.extend(values);
    Ok(all.into_iter().filter(|s| s.len() >= 6).collect())
}

fn no_secrets_in(text: &str, world: &ApiWorld, extra: &[&str]) -> R {
    for secret in secrets(world)?
        .iter()
        .map(String::as_str)
        .chain(extra.iter().copied())
    {
        expect(
            !text.contains(secret),
            "構造化ログに、資格・参加コード・復帰コード・表示名が含まれている",
        )?;
    }
    Ok(())
}

#[then("構造化ログの全体に、資格・参加コード・復帰コード・参加者の表示名は含まれない")]
async fn logs_have_no_secrets(world: &mut ApiWorld) -> R {
    expect(capture_logs(), "ログを捕捉できない")?;
    let logs = captured_logs();
    expect(!logs.is_empty(), "ログが出力されていない")?;
    // 表示名は、参加者ごとに作ったもの（`named` の鍵）
    let names: Vec<String> = world.game()?.named.keys().cloned().collect();
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    no_secrets_in(&logs, world, &names)
}

#[then("相関 ID、操作、結果、所要時間を含む構造化ログが出力される")]
async fn structured_log_emitted(world: &mut ApiWorld) -> R {
    expect(capture_logs(), "ログを捕捉できない")?;
    let correlation = world
        .reply()?
        .headers
        .get("x-correlation-id")
        .cloned()
        .ok_or("応答に相関 ID が無い")?;
    let record = captured_logs()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|v| v.pointer("/fields/correlation_id") == Some(&Value::from(correlation.clone())))
        .ok_or("相関 ID を含む構造化ログが無い")?;
    for field in ["method", "path", "status", "elapsed_ms"] {
        expect(
            record.pointer(&format!("/fields/{field}")).is_some(),
            &format!("ログに {field} が無い"),
        )?;
    }
    Ok(())
}

#[then(regex = r"^そのログに、資格、表示名「(.+)」、非公開の値は含まれない$")]
async fn that_log_has_no_secrets(world: &mut ApiWorld, name: String) -> R {
    let correlation = world
        .reply()?
        .headers
        .get("x-correlation-id")
        .cloned()
        .ok_or("応答に相関 ID が無い")?;
    let line = captured_logs()
        .lines()
        .find(|l| l.contains(&correlation))
        .map(str::to_owned)
        .ok_or("相関 ID を含む構造化ログが無い")?;
    no_secrets_in(&line, world, &[name.as_str()])
}

#[when("進行役の状況の取得、資格の無い状況の取得、存在しない経路の要求を、それぞれ送る")]
async fn send_three(world: &mut ApiWorld) -> R {
    let (id, cookie) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    let state = format!("/api/v1/games/{id}/state");
    let mut replies = Vec::new();
    replies.push(world.call("GET", &state, Some(&cookie), None, "").await?);
    replies.push(world.call("GET", &state, None, None, "").await?);
    replies.push(
        world
            .call("GET", "/api/v1/no-such-route", None, None, "")
            .await?,
    );
    world.replies = replies;
    Ok(())
}

#[then("どの応答にも、CSP・HSTS・nosniff・Referrer-Policy・キャッシュ無効のヘッダーが付く")]
async fn security_headers(world: &mut ApiWorld) -> R {
    expect(world.replies.len() == 3, "3 つの応答が無い")?;
    // 成功・拒否・存在しない経路の、それぞれ
    let statuses: Vec<u16> = world.replies.iter().map(|r| r.status).collect();
    expect(
        statuses.first() == Some(&200) && statuses.get(2) == Some(&404),
        &format!("応答の状態が想定と違う: {statuses:?}"),
    )?;
    for reply in &world.replies {
        let header = |name: &str| reply.headers.get(name).cloned().unwrap_or_default();
        let at = reply.status;
        expect(
            header("content-security-policy").contains("default-src 'none'")
                && header("content-security-policy").contains("frame-ancestors 'none'"),
            &format!("CSP が無い（{at}）"),
        )?;
        expect(
            header("strict-transport-security").contains("max-age=31536000"),
            &format!("HSTS が無い（{at}）"),
        )?;
        expect(
            header("x-content-type-options") == "nosniff",
            &format!("nosniff が無い（{at}）"),
        )?;
        expect(
            header("referrer-policy") == "no-referrer",
            &format!("Referrer-Policy が無い（{at}）"),
        )?;
        expect(
            header("cache-control") == "no-store",
            &format!("キャッシュ無効が無い（{at}）"),
        )?;
    }
    Ok(())
}

#[then("生存のヘルスチェックは成功のままである")]
async fn liveness_stays_ok(world: &mut ApiWorld) -> R {
    let reply = world.call("GET", "/api/v1/health", None, None, "").await?;
    expect(reply.status == 200, "生存の確認が失敗した")
}
