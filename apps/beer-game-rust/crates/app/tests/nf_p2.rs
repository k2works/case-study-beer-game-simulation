// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! NF-P2（確定から他の参加者の画面への反映）の実測。**測って記録する**（数値の目標は、実測の後に人が決める。RN1）。
//! 同期投影なので、確定の応答が返った時点で、参加者の状態の取得に反映されている。画面が 3 秒のポーリングなら、
//! 反映までの最大は「ポーリングの間隔 + 取得の所要」になる。ここでは、確定の所要と、確定の直後の取得の所要を測る。

use std::io::Write;
use std::time::Instant;

use axum::http::StatusCode;
use serde_json::json;

mod support;
use support::api::{app, prepared, send};
use support::start;

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let index = (((sorted.len() as f64) * p).ceil() as usize).saturating_sub(1);
    sorted
        .get(index.min(sorted.len().saturating_sub(1)))
        .copied()
        .unwrap_or(0.0)
}

#[tokio::test]
async fn nf_p2__確定の直後に_別の参加者の状態の取得が第_2_週を返す_所要を記録する()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let mut commit_ms = Vec::new();
    let mut visible_ms = Vec::new();
    for round in 0..12 {
        let game = prepared(&app, &env.pool).await?;
        send(
            &app,
            "POST",
            &format!("/api/v1/games/{}/start", game.id),
            &[("cookie", &game.facilitator), ("idempotency-key", "s")],
            "",
        )
        .await?;
        for (i, (_, _, cookie)) in game.players.iter().enumerate() {
            send(
                &app,
                "PUT",
                &format!("/api/v1/sessions/{}/decisions", game.id),
                &[("cookie", cookie), ("idempotency-key", &format!("d{i}"))],
                &json!({"week": 1, "quantity": 5}).to_string(),
            )
            .await?;
        }
        let commit = json!({"requestedWeek": 1, "basis": {"FACTORY": 1, "DISTRIBUTOR": 1, "WHOLESALER": 1, "RETAILER": 1}}).to_string();
        let started = Instant::now();
        let (status, _, _) = send(
            &app,
            "POST",
            &format!("/api/v1/sessions/{}/weeks/1/commit", game.id),
            &[("cookie", &game.facilitator), ("idempotency-key", "c")],
            &commit,
        )
        .await?;
        let committed = started.elapsed();
        assert_eq!(status, StatusCode::OK);
        // 別の参加者（小売店）が、確定の直後に状態を取得する
        let (status, _, body) = send(
            &app,
            "GET",
            &format!("/api/v1/sessions/{}/state", game.id),
            &[("cookie", &game.players[3].2)],
            "",
        )
        .await?;
        let visible = started.elapsed();
        assert_eq!(
            (status, body.get("week")),
            (StatusCode::OK, Some(&json!(2))),
            "round {round}: 確定の直後に第 2 週が見える"
        );
        commit_ms.push(committed.as_secs_f64() * 1000.0);
        visible_ms.push(visible.as_secs_f64() * 1000.0);
    }
    commit_ms.sort_by(f64::total_cmp);
    visible_ms.sort_by(f64::total_cmp);
    drop(writeln!(
        std::io::stderr(),
        "[NF-P2] 確定の応答まで p50={:.1}ms p95={:.1}ms / 確定から別の参加者の取得が第 2 週を返すまで p50={:.1}ms p95={:.1}ms（n={}、ローカル、実 PostgreSQL 18.6）",
        percentile(&commit_ms, 0.5),
        percentile(&commit_ms, 0.95),
        percentile(&visible_ms, 0.5),
        percentile(&visible_ms, 0.95),
        visible_ms.len()
    ));
    // 目標値の確定は、実測の後に人が決める。ここでは、緩い上限（NF-P16 の 2 秒）だけ確認する
    assert!(percentile(&visible_ms, 0.95) < 2000.0);
    Ok(())
}
