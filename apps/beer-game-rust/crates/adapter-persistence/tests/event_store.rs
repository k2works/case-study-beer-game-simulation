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
async fn 追記したイベントを版つきで読める() -> Result<(), String> {
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
async fn マイグレーション_0001_から_0005_が適用され_game_roots_の削除が全表へ連鎖する()
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
    // game_roots、events、projection_checkpoints と、周辺ストア 4、投影 12（設計: data-model）
    if tables.len() != 3 + 4 + 12 {
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
