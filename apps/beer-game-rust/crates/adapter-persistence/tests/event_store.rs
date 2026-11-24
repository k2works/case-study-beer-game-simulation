// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! イベントストアの統合テスト（実 PostgreSQL 18.6。testcontainers）。
//! RB2 の前提の検証: 制約名の取得と実際の並行、明示の ROLLBACK、`Tx` の drop での ROLLBACK のタイミング。
//! Docker が無いとき、`CI` 環境変数があれば失敗、無ければ（手元では）スキップする（DS-13 の入口。件数の検査は B3）。

use std::sync::Arc;
use std::time::{Duration, Instant};

use beergame_adapter_persistence::{EventCodec, PgEventStore, StreamType};
use beergame_application::{AppFailure, EventStore};
use sqlx::PgPool;
use uuid::Uuid;

mod support;
use support::{new_game, say, start};

struct NumberCodec;

impl EventCodec<i32> for NumberCodec {
    fn encode(&self, event: &i32) -> Result<(String, i32, serde_json::Value), String> {
        Ok(("Number".to_owned(), 1, serde_json::json!({ "n": event })))
    }

    fn decode(
        &self,
        event_type: &str,
        _schema_version: i32,
        payload: serde_json::Value,
    ) -> Result<i32, String> {
        match (
            event_type,
            payload.get("n").and_then(serde_json::Value::as_i64),
        ) {
            ("Number", Some(n)) => i32::try_from(n).map_err(|e| e.to_string()),
            (other, _) => Err(format!("不明なイベント: {other}")),
        }
    }
}

type Store = PgEventStore<i32, NumberCodec>;

fn store(pool: &PgPool, game: Uuid) -> Store {
    PgEventStore::new(pool.clone(), game, StreamType::Session, NumberCodec)
}

fn e<T: std::fmt::Debug>(x: T) -> String {
    format!("{x:?}")
}

#[tokio::test]
async fn ds13__postgres_18_6_を固定して起動できる() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let version: String = sqlx::query_scalar("SHOW server_version")
        .fetch_one(&env.pool)
        .await
        .map_err(e)?;
    if version.starts_with("18.6") {
        Ok(())
    } else {
        Err(format!("PostgreSQL 18.6 ではない: {version}"))
    }
}

#[tokio::test]
async fn tech__追記したイベントを版つきで読める() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let game = new_game(&env.pool).await?;
    let s = store(&env.pool, game);
    let mut tx = s.begin().await.map_err(e)?;
    assert_eq!(s.read(&mut tx).await.map(|r| r.version), Ok(0));
    assert_eq!(s.append(&mut tx, 0, vec![10, 20]).await, Ok(2));
    s.commit(tx).await.map_err(e)?;
    let mut tx = s.begin().await.map_err(e)?;
    let read = s.read(&mut tx).await.map_err(e)?;
    assert_eq!((read.events, read.version), (vec![10, 20], 2));
    s.rollback(tx).await.map_err(e)?;
    Ok(())
}

#[tokio::test]
async fn rb2__実際の並行で_一方だけが成功し_他方は制約名から競合になる() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let game = new_game(&env.pool).await?;
    let s = Arc::new(store(&env.pool, game));
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let mut handles = Vec::new();
    for n in [1, 2] {
        let (s, barrier) = (Arc::clone(&s), Arc::clone(&barrier));
        handles.push(tokio::spawn(async move {
            let mut tx = s.begin().await?;
            let version = s.read(&mut tx).await?.version;
            barrier.wait().await;
            match s.append(&mut tx, version, vec![n]).await {
                Ok(v) => {
                    s.commit(tx).await?;
                    Ok(v)
                }
                Err(failure) => {
                    drop(s.rollback(tx).await);
                    Err(failure)
                }
            }
        }));
    }
    let mut results = Vec::new();
    for h in handles {
        results.push(h.await.map_err(e)?);
    }
    let ok = results.iter().filter(|r| r.is_ok()).count();
    let conflicts = results
        .iter()
        .filter(|r| matches!(r, Err(AppFailure::ConcurrencyConflict)))
        .count();
    if (ok, conflicts) == (1, 1) {
        Ok(())
    } else {
        Err(format!(
            "一方だけが成功し、他方が競合になるはず: {results:?}"
        ))
    }
}

#[tokio::test]
async fn rb2__明示の_rollback_で_同じ版への追記がすぐ通る() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let game = new_game(&env.pool).await?;
    let s = store(&env.pool, game);
    let mut a = s.begin().await.map_err(e)?;
    s.append(&mut a, 0, vec![1]).await.map_err(e)?;
    s.rollback(a).await.map_err(e)?;
    let started = Instant::now();
    let mut b = s.begin().await.map_err(e)?;
    s.append(&mut b, 0, vec![2]).await.map_err(e)?;
    s.commit(b).await.map_err(e)?;
    say(&format!(
        "[RB2] 明示の rollback の後、次の追記が通るまで {:?}",
        started.elapsed()
    ));
    if started.elapsed() < Duration::from_secs(1) {
        Ok(())
    } else {
        Err("明示の rollback の後も、ロックが残った".to_owned())
    }
}

/// `Tx` を rollback せずに drop したとき、いつ ROLLBACK が送られ、ロックが解放されるかを測る（保険の確認）。
#[tokio::test]
async fn rb2__tx_の_drop_は_ロックを解放する_測定して記録する() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let game = new_game(&env.pool).await?;
    let s = store(&env.pool, game);
    let mut a = s.begin().await.map_err(e)?;
    s.append(&mut a, 0, vec![1]).await.map_err(e)?;
    drop(a); // rollback も commit もしない
    let started = Instant::now();
    // 同じ版への追記は、A の未コミットの行が残っていれば、A が終わるまで待たされる
    let mut b = s.begin().await.map_err(e)?;
    let appended =
        tokio::time::timeout(Duration::from_secs(10), s.append(&mut b, 0, vec![2])).await;
    let elapsed = started.elapsed();
    say(&format!(
        "[RB2] drop の後、同じ版への追記が通るまで {elapsed:?}（{appended:?}）"
    ));
    let states: Vec<String> = sqlx::query_scalar(
        "SELECT state FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
    )
    .fetch_all(&env.pool)
    .await
    .map_err(e)?;
    say(&format!("[RB2] 接続の状態: {states:?}"));
    match appended {
        Ok(Ok(2 | 1)) => {
            s.rollback(b).await.map_err(e)?;
            Ok(())
        }
        other => Err(format!("drop した Tx のロックが解放されない: {other:?}")),
    }
}

#[tokio::test]
async fn tech__マイグレーション_0001_から_0009_が適用され_game_roots_の削除が全表へ連鎖する()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' \
         AND table_name <> '_sqlx_migrations' ORDER BY table_name",
    )
    .fetch_all(&env.pool)
    .await
    .map_err(e)?;
    // game_roots、events、projection_checkpoints と、周辺ストア 4、投影 12、参加・復帰の失敗の窓 1、保持と削除 4（設計: data-model）
    if tables.len() != 3 + 4 + 12 + 1 + 4 {
        return Err(format!("表の数が違う: {tables:?}"));
    }
    let game = new_game(&env.pool).await?;
    let s = store(&env.pool, game);
    let mut tx = s.begin().await.map_err(e)?;
    s.append(&mut tx, 0, vec![1]).await.map_err(e)?;
    s.commit(tx).await.map_err(e)?;
    sqlx::query("DELETE FROM game_roots WHERE game_id = $1")
        .bind(game)
        .execute(&env.pool)
        .await
        .map_err(e)?;
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE game_id = $1")
        .bind(game)
        .fetch_one(&env.pool)
        .await
        .map_err(e)?;
    if left == 0 {
        Ok(())
    } else {
        Err(format!("連鎖削除で events が残った: {left}"))
    }
}

#[tokio::test]
async fn nf_r15__追記と同じトランザクションで_進んだ版の記録がストリームの最後の版になる()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let game = new_game(&env.pool).await?;
    let s = store(&env.pool, game);
    let mut tx = s.begin().await.map_err(e)?;
    s.append(&mut tx, 0, vec![1, 2]).await.map_err(e)?;
    s.commit(tx).await.map_err(e)?;
    let mut tx = s.begin().await.map_err(e)?;
    s.append(&mut tx, 2, vec![3]).await.map_err(e)?;
    s.rollback(tx).await.map_err(e)?;
    let projected: Option<i64> = sqlx::query_scalar(
        "SELECT projected_version FROM projection_checkpoints \
         WHERE game_id = $1 AND stream_type = 'SESSION'",
    )
    .bind(game)
    .fetch_optional(&env.pool)
    .await
    .map_err(e)?;
    // 取り消した追記は記録に残らない
    if projected == Some(2) {
        Ok(())
    } else {
        Err(format!("進んだ版の記録が 2 のはず: {projected:?}"))
    }
}

/// 再構築が握る排他のロックを、別のトランザクションで再現する（鍵は `begin` の共有のロックと同じ）。
async fn hold_exclusive(
    pool: &PgPool,
    game: Uuid,
) -> Result<sqlx::Transaction<'static, sqlx::Postgres>, String> {
    let mut tx = pool.begin().await.map_err(e)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(game)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    Ok(tx)
}

#[tokio::test]
async fn nf_r15__再構築の排他のロックの間_コマンドの開始は待ちの上限のあと再試行可能な失敗になる()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let game = new_game(&env.pool).await?;
    let rebuild = hold_exclusive(&env.pool, game).await?;
    let started = Instant::now();
    let result = store(&env.pool, game).begin().await;
    let waited = started.elapsed();
    drop(rebuild.rollback().await);
    match result {
        Err(AppFailure::RetryExhausted) => {}
        other => return Err(format!("RetryExhausted になるはず: {:?}", other.err())),
    }
    // lock_timeout（初期値 2 秒）で切れる。無期限には待たない
    if waited < Duration::from_secs(10) {
        Ok(())
    } else {
        Err(format!("待ちが長すぎる: {waited:?}"))
    }
}

#[tokio::test]
async fn nf_r15__再構築が終われば_コマンドの開始は通る() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let game = new_game(&env.pool).await?;
    let rebuild = hold_exclusive(&env.pool, game).await?;
    rebuild.rollback().await.map_err(e)?;
    let s = store(&env.pool, game);
    let tx = s.begin().await.map_err(e)?;
    s.rollback(tx).await.map_err(e)
}

#[tokio::test]
async fn nf_r15__コマンド同士の共有のロックは互いを待たせず_別のゲームの再構築にも待たされない()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let game = new_game(&env.pool).await?;
    let other = new_game(&env.pool).await?;
    let rebuild_other = hold_exclusive(&env.pool, other).await?;
    let (a, b) = (store(&env.pool, game), store(&env.pool, game));
    let started = Instant::now();
    let tx_a = a.begin().await.map_err(e)?;
    let tx_b = b.begin().await.map_err(e)?;
    let waited = started.elapsed();
    a.rollback(tx_a).await.map_err(e)?;
    b.rollback(tx_b).await.map_err(e)?;
    rebuild_other.rollback().await.map_err(e)?;
    if waited < Duration::from_secs(1) {
        Ok(())
    } else {
        Err(format!("共有のロックが待たされた: {waited:?}"))
    }
}

#[tokio::test]
async fn nf_r15__ロックの待ちが切れても_接続は戻りプールは使い続けられる() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let game = new_game(&env.pool).await?;
    let rebuild = hold_exclusive(&env.pool, game).await?;
    // 待ちが切れるたびに接続が戻らないと、プールが枯渇する（RT2）。プールの上限より多く繰り返す
    let attempts = env.pool.options().get_max_connections() + 2;
    for _ in 0..attempts {
        let result = store(&env.pool, game).begin().await;
        if !matches!(result, Err(AppFailure::RetryExhausted)) {
            drop(rebuild.rollback().await);
            return Err("待ちが切れて RetryExhausted になるはず".to_owned());
        }
    }
    rebuild.rollback().await.map_err(e)?;
    let s = store(&env.pool, game);
    let tx = s.begin().await.map_err(e)?;
    s.rollback(tx).await.map_err(e)
}
