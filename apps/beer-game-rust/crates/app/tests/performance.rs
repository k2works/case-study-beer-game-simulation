// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 性能・負荷の計測（B16。NF-P1・P2 の下限・P3・P9・P15・P18、NF-C1）。実 PostgreSQL 18.6（Testcontainers）の上で、
//! インプロセスの HTTP ルーターを呼ぶ。**ネットワーク・ブラウザ・SSE・複数タスクを含まない**（本番の値ではなく、下限の目安）。
//!
//! 既定は縮小した規模（標本が少なく、p95 は参考値。上限は緩い）。環境変数 `BEERGAME_MEASURE=1` で、NFR の規模で実行する。
//! 結果は、標準エラーと `target/performance-measurement.md` に追記する。**測っていないものは書かない。**

use std::io::Write;
use std::time::{Duration, Instant};

use axum::Router;
use axum::http::StatusCode;
use beergame_adapter_persistence::PgProjectionMaintenance;
use beergame_application::ProjectionMaintenance;
use beergame_domain::GameId;
use serde_json::{Value, json};
use sqlx::PgPool;

mod support;
use support::api::{Game, app, e, prepared_with, send};
use support::start;

fn full() -> bool {
    std::env::var("BEERGAME_MEASURE").is_ok_and(|v| v == "1")
}

fn scale() -> &'static str {
    if full() {
        "全規模（NFR）"
    } else {
        "縮小（参考値）"
    }
}

/// 標本の集まり（ミリ秒）。
#[derive(Default)]
struct Latencies(Vec<f64>);

impl Latencies {
    fn push(&mut self, elapsed: Duration) {
        self.0.push(elapsed.as_secs_f64() * 1000.0);
    }

    fn sorted(&self) -> Vec<f64> {
        let mut v = self.0.clone();
        v.sort_by(f64::total_cmp);
        v
    }

    /// 切り上げた順位の値（標本が無ければ 0）。
    fn percentile(&self, q: f64) -> f64 {
        let sorted = self.sorted();
        if sorted.is_empty() {
            return 0.0;
        }
        // 標本の数は小さい（f64 に収まる範囲）
        #[allow(
            clippy::cast_precision_loss,
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss
        )]
        let rank = ((q * sorted.len() as f64).ceil() as usize).max(1);
        sorted.get(rank - 1).copied().unwrap_or(0.0)
    }

    fn summary(&self) -> String {
        format!(
            "n={} p50={:.1} ms p95={:.1} ms max={:.1} ms",
            self.0.len(),
            self.percentile(0.5),
            self.percentile(0.95),
            self.percentile(1.0)
        )
    }
}

/// 結果を、標準エラーと `target/performance-measurement.md` に追記する。
fn record(name: &str, text: &str) {
    let line = format!("- [{}] {name}: {text}\n", scale());
    drop(write!(std::io::stderr(), "{line}"));
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/performance-measurement.md");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        drop(file.write_all(line.as_bytes()));
    }
}

/// 上限の検査。全規模は NFR の値、縮小は緩い上限（環境の揺らぎで落ちないように）。
fn within(name: &str, latencies: &Latencies, nfr_millis: f64) -> Result<(), String> {
    let limit = if full() { nfr_millis } else { 10_000.0 };
    let p95 = latencies.percentile(0.95);
    if p95 <= limit {
        Ok(())
    } else {
        Err(format!(
            "{name}: p95 {p95:.1} ms が上限 {limit} ms を超えた（{}）",
            latencies.summary()
        ))
    }
}

async fn created(router: &Router, pool: &PgPool, weeks: usize) -> Result<Game, String> {
    let body = json!({"kind": "KIT", "finalWeek": weeks, "demand": vec![4; weeks]});
    let game = prepared_with(router, pool, &body).await?;
    let (status, _, text) = send(
        router,
        "POST",
        &format!("/api/v1/games/{}/start", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", "start")],
        "",
    )
    .await?;
    if status != StatusCode::OK {
        return Err(format!("開始できない: {status} {text}"));
    }
    Ok(game)
}

/// 1 週ぶんの入力（4 役割。順に）と確定。確定の所要時間を返す。
async fn play_week(
    router: &Router,
    game: &Game,
    week: usize,
    tag: &str,
) -> Result<Duration, String> {
    for (i, (_, _, cookie)) in game.players.iter().enumerate() {
        let (status, _, body) = send(
            router,
            "PUT",
            &format!("/api/v1/sessions/{}/decisions", game.id),
            &[
                ("cookie", cookie),
                ("idempotency-key", &format!("{tag}-s{week}-{i}")),
                ("if-match", "0"),
            ],
            &json!({"week": week, "quantity": 4}).to_string(),
        )
        .await?;
        if status != StatusCode::OK {
            return Err(format!("保存できない（週 {week}）: {status} {body}"));
        }
    }
    commit(router, game, week, tag).await
}

async fn commit(router: &Router, game: &Game, week: usize, tag: &str) -> Result<Duration, String> {
    let basis = json!({"FACTORY": 1, "DISTRIBUTOR": 1, "WHOLESALER": 1, "RETAILER": 1});
    let started = Instant::now();
    let (status, _, body) = send(
        router,
        "POST",
        &format!("/api/v1/sessions/{}/weeks/{week}/commit", game.id),
        &[
            ("cookie", &game.facilitator),
            ("idempotency-key", &format!("{tag}-c{week}")),
        ],
        &json!({"requestedWeek": week, "basis": basis}).to_string(),
    )
    .await?;
    let elapsed = started.elapsed();
    if status != StatusCode::OK {
        return Err(format!("確定できない（週 {week}）: {status} {body}"));
    }
    Ok(elapsed)
}

/// 同時の呼び出し 1 件。（所要時間, 状態, 本文）
async fn call(
    router: Router,
    method: &'static str,
    uri: String,
    extra: Vec<(String, String)>,
    body: String,
) -> Result<(Duration, StatusCode, Value), String> {
    let headers: Vec<(&str, &str)> = extra
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let started = Instant::now();
    let (status, _, value) = send(&router, method, &uri, &headers, &body).await?;
    Ok((started.elapsed(), status, value))
}

async fn all<T>(
    handles: Vec<tokio::task::JoinHandle<Result<T, String>>>,
) -> Result<Vec<T>, String> {
    let mut out = Vec::new();
    for handle in handles {
        out.push(handle.await.map_err(e)??);
    }
    Ok(out)
}

#[tokio::test]
async fn nf_p1__15_ゲーム_75_並行の保存_状態の取得_確定_と_反映の下限() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let router = app(env.pool.clone());
    let games_count = if full() { 15 } else { 3 };
    let reads = if full() { 8 } else { 2 };
    let mut games = Vec::new();
    for _ in 0..games_count {
        games.push(created(&router, &env.pool, 3).await?);
    }

    // 保存: 全参加者が、同時に第 1 週を保存する。**同じゲームの 4 人が同時に保存すると、追記の競合で、自動再試行（3 回）を使い切り、
    // 再送可能な 503（`app.retry_exhausted`）になることがある**。503 の件数を数え、画面の契約（もう一度お試しください）のとおり、
    // 同じ冪等キーで再送して成功することを確かめる（最大 4 回）。
    let mut handles = Vec::new();
    for (g, game) in games.iter().enumerate() {
        for (i, (_, _, cookie)) in game.players.iter().enumerate() {
            let (router, uri, cookie, key) = (
                router.clone(),
                format!("/api/v1/sessions/{}/decisions", game.id),
                cookie.clone(),
                format!("p1-s-{g}-{i}"),
            );
            handles.push(tokio::spawn(async move {
                let mut first = None;
                for attempt in 0..4_u32 {
                    let headers = vec![
                        ("cookie".to_owned(), cookie.clone()),
                        ("idempotency-key".to_owned(), key.clone()),
                        ("if-match".to_owned(), "0".to_owned()),
                    ];
                    let (elapsed, status, body) = call(
                        router.clone(),
                        "PUT",
                        uri.clone(),
                        headers,
                        json!({"week": 1, "quantity": 4}).to_string(),
                    )
                    .await?;
                    first.get_or_insert(elapsed);
                    if status == StatusCode::OK {
                        return Ok((first.unwrap_or(elapsed), attempt));
                    }
                    if status != StatusCode::SERVICE_UNAVAILABLE {
                        return Err(format!("保存が失敗: {status} {body}"));
                    }
                }
                Err("再送しても、保存が 503 のまま".to_owned())
            }));
        }
    }
    let mut saves = Latencies::default();
    let mut retried = 0_usize;
    for (elapsed, attempt) in all(handles).await? {
        saves.push(elapsed);
        retried += usize::from(attempt > 0);
    }

    // 状態の取得（NF-P1。75 並行）: 参加者ごとに 1 つの利用者が、**順に**繰り返し取得する（同時に出ている要求は最大 75 件）
    let mut handles = Vec::new();
    for game in &games {
        for (_, _, cookie) in &game.players {
            let (router, uri, cookie) = (
                router.clone(),
                format!("/api/v1/sessions/{}/state", game.id),
                cookie.clone(),
            );
            handles.push(tokio::spawn(async move {
                let mut out = Vec::new();
                for _ in 0..reads {
                    let (elapsed, status, body) = call(
                        router.clone(),
                        "GET",
                        uri.clone(),
                        vec![("cookie".into(), cookie.clone())],
                        String::new(),
                    )
                    .await?;
                    if status != StatusCode::OK {
                        return Err(format!("状態の取得が失敗: {status} {body}"));
                    }
                    out.push(elapsed);
                }
                Ok(out)
            }));
        }
    }
    let mut states = Latencies::default();
    for elapsed in all(handles).await?.into_iter().flatten() {
        states.push(elapsed);
    }

    // 一斉の取得（ストレス。NFR の「75 並行」より厳しい。合否は付けない）: 全要求を、同時に出す
    let mut handles = Vec::new();
    for game in &games {
        for (_, _, cookie) in &game.players {
            for _ in 0..reads {
                handles.push(tokio::spawn(call(
                    router.clone(),
                    "GET",
                    format!("/api/v1/sessions/{}/state", game.id),
                    vec![("cookie".into(), cookie.clone())],
                    String::new(),
                )));
            }
        }
    }
    let mut burst = Latencies::default();
    for (elapsed, status, body) in all(handles).await? {
        if status != StatusCode::OK {
            return Err(format!("状態の取得（一斉）が失敗: {status} {body}"));
        }
        burst.push(elapsed);
    }

    // 確定: 全ゲームが、同時に第 1 週を確定する（NF-P3 の短いストリーム）
    let basis = json!({"FACTORY": 1, "DISTRIBUTOR": 1, "WHOLESALER": 1, "RETAILER": 1});
    let mut handles = Vec::new();
    for (g, game) in games.iter().enumerate() {
        handles.push(tokio::spawn(call(
            router.clone(),
            "POST",
            format!("/api/v1/sessions/{}/weeks/1/commit", game.id),
            vec![
                ("cookie".into(), game.facilitator.clone()),
                ("idempotency-key".into(), format!("p1-c-{g}")),
            ],
            json!({"requestedWeek": 1, "basis": basis}).to_string(),
        )));
    }
    let mut commits = Latencies::default();
    for (elapsed, status, body) in all(handles).await? {
        if status != StatusCode::OK {
            return Err(format!("確定が失敗: {status} {body}"));
        }
        commits.push(elapsed);
    }

    // 確定の直後に、別の参加者が取得して、第 2 週が見えるまで（同期投影のため、確定の応答の時点で見える下限）
    let mut visible = Latencies::default();
    for game in &games {
        let (_, _, cookie) = game.players.first().ok_or("参加者が無い")?;
        let started = Instant::now();
        let (status, _, body) = send(
            &router,
            "GET",
            &format!("/api/v1/sessions/{}/state", game.id),
            &[("cookie", cookie)],
            "",
        )
        .await?;
        visible.push(started.elapsed());
        if status != StatusCode::OK || body.get("week") != Some(&json!(2)) {
            return Err(format!("確定の直後に第 2 週が見えない: {status} {body}"));
        }
    }

    record(
        "NF-P1・P13・C1 保存（同時。最初の要求の所要）",
        &saves.summary(),
    );
    record(
        "NF-C 保存（同時）で、再試行の上限超過の 503 になり、再送が要った件数",
        &format!(
            "{retried} / {}（自動再試行の既定 3 回。同じゲームの 4 人が同時に保存）",
            saves.0.len()
        ),
    );
    record(
        "NF-P1・P7 状態の取得（75 並行。利用者ごとに順次）",
        &states.summary(),
    );
    record(
        "（ストレス）状態の取得（全要求を一斉に出す。接続プール 8 本。合否なし）",
        &burst.summary(),
    );
    record("NF-P3（短いストリーム）確定（同時）", &commits.summary());
    record(
        "NF-P2 の下限（ポーリング無し）確定後の取得",
        &visible.summary(),
    );
    // NF-P2: 画面は 3 秒間隔のポーリング。確定の時刻に対して、次のポーリングが来るまでの待ち（0〜3 秒の一様）+ 取得の所要
    let mut reflection = Latencies::default();
    for phase in 0..300_u32 {
        for sample in &visible.0 {
            reflection.0.push(f64::from(phase) * 10.0 + sample);
        }
    }
    record(
        "NF-P2 の推定（3 秒間隔のポーリング。待ちの一様な位相 × 計測した取得の所要。**画面を介した実測ではない**）",
        &reflection.summary(),
    );

    within("保存", &saves, 1000.0)?;
    within("状態の取得", &states, 1000.0)?;
    within("確定", &commits, 1000.0)
}

/// SESSION のイベントの数。
async fn session_events(pool: &PgPool, game: &Game) -> Result<i64, String> {
    sqlx::query_scalar(
        "SELECT count(*) FROM events WHERE game_id = $1::uuid AND stream_type = 'SESSION'",
    )
    .bind(&game.id)
    .fetch_one(pool)
    .await
    .map_err(e)
}

/// 停止・再開を繰り返して、SESSION のストリームを `target` 件以上にする。最後の 40 回の所要時間を返す。
async fn grow_stream(
    router: &Router,
    pool: &PgPool,
    game: &Game,
    target: i64,
    tag: &str,
) -> Result<Latencies, String> {
    let mut recent = Latencies::default();
    let mut n = 0_usize;
    while session_events(pool, game).await? < target {
        for action in ["pause", "resume"] {
            n += 1;
            let started = Instant::now();
            let (status, _, body) = send(
                router,
                "POST",
                &format!("/api/v1/sessions/{}/{action}", game.id),
                &[
                    ("cookie", &game.facilitator),
                    ("idempotency-key", &format!("{tag}-{action}-{n}")),
                ],
                "",
            )
            .await?;
            if status != StatusCode::OK {
                return Err(format!("{action} できない: {status} {body}"));
            }
            recent.0.push(started.elapsed().as_secs_f64() * 1000.0);
            if recent.0.len() > 40 {
                recent.0.remove(0);
            }
        }
    }
    Ok(recent)
}

#[tokio::test]
async fn nf_p15__長いストリームの更新_確定_再構築_NF_P3_NF_P18() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let router = app(env.pool.clone());
    let game = created(&router, &env.pool, 3).await?;
    let (first, second) = if full() { (1000, 2000) } else { (100, 200) };

    // 想定の長さ（1000 件）
    let at_first = grow_stream(&router, &env.pool, &game, first, "g1").await?;
    let events = session_events(&env.pool, &game).await?;
    let commit_first = play_week(&router, &game, 1, "w1").await?;
    record(
        &format!("NF-P15・P3 停止・再開（ストリーム {events} 件。最後の 40 回）"),
        &at_first.summary(),
    );
    record(
        &format!("NF-P3 確定（ストリーム約 {events} 件。n=1）"),
        &format!("{:.1} ms", commit_first.as_secs_f64() * 1000.0),
    );

    let maintenance = PgProjectionMaintenance::new(env.pool.clone());
    let game_id = GameId::new(u128::from_str_radix(&game.id.replace('-', ""), 16).map_err(e)?);
    let rebuilds = if full() { 10 } else { 3 };
    let mut rebuild = Latencies::default();
    let mut verify = Latencies::default();
    for _ in 0..rebuilds {
        let started = Instant::now();
        maintenance.rebuild(game_id).await.map_err(e)?;
        rebuild.push(started.elapsed());
        let started = Instant::now();
        maintenance.verify(game_id).await.map_err(e)?;
        verify.push(started.elapsed());
    }
    let events_now = session_events(&env.pool, &game).await?;
    record(
        &format!("NF-P18 再構築（SESSION {events_now} 件）"),
        &rebuild.summary(),
    );
    record(
        &format!("NF-P18 検査（再構築と同じ作業 + 取り消し。SESSION {events_now} 件）"),
        &verify.summary(),
    );

    // 最大の長さ（2000 件）
    let at_second = grow_stream(&router, &env.pool, &game, second, "g2").await?;
    let events = session_events(&env.pool, &game).await?;
    let commit_second = play_week(&router, &game, 2, "w2").await?;
    record(
        &format!("NF-P3 停止・再開（ストリーム {events} 件。最後の 40 回）"),
        &at_second.summary(),
    );
    record(
        &format!("NF-P3 確定（ストリーム約 {events} 件。n=1）"),
        &format!("{:.1} ms", commit_second.as_secs_f64() * 1000.0),
    );

    // 1 件の更新の p95 が、NFR（NF-P3: 1 秒）以下。再構築は、記録するだけ（NF-P18 の判断は人。B13 報告）
    within("停止・再開（想定の長さ）", &at_first, 1000.0)?;
    within("停止・再開（最大の長さ）", &at_second, 1000.0)?;
    let limit = if full() { 1000.0 } else { 10_000.0 };
    if commit_first.as_secs_f64() * 1000.0 > limit || commit_second.as_secs_f64() * 1000.0 > limit {
        return Err("長いストリームでの確定が上限を超えた".to_owned());
    }
    Ok(())
}

#[tokio::test]
async fn nf_p9__50_週_4_役割の出力_CSV_JSON() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let router = app(env.pool.clone());
    let weeks = if full() { 50 } else { 10 };
    let game = created(&router, &env.pool, weeks).await?;
    for week in 1..=weeks {
        play_week(&router, &game, week, "x").await?;
    }
    let mut csv = Latencies::default();
    let mut json_export = Latencies::default();
    let runs = if full() { 10 } else { 2 };
    for _ in 0..runs {
        for (format, samples) in [("csv", &mut csv), ("json", &mut json_export)] {
            let started = Instant::now();
            let (status, _, _) = send(
                &router,
                "GET",
                &format!("/api/v1/games/{}/exports?format={format}", game.id),
                &[("cookie", &game.facilitator)],
                "",
            )
            .await?;
            samples.push(started.elapsed());
            if status != StatusCode::OK {
                return Err(format!("出力できない: {format} {status}"));
            }
        }
    }
    record(
        &format!("NF-P9 CSV 出力（{weeks} 週 × 4 役割。静か）"),
        &csv.summary(),
    );
    record(
        &format!("NF-P9 JSON 出力（{weeks} 週 × 4 役割。静か）"),
        &json_export.summary(),
    );
    within("CSV 出力", &csv, 30_000.0)?;
    within("JSON 出力", &json_export, 30_000.0)
}
