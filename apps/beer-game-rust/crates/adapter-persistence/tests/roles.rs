// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! DB ロールと GRANT（NF-S18、BR-17）。events の追記専用、観察者の最小権限、削除ロールの連鎖削除。実 PostgreSQL 18.6。

use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

mod support;
use support::{new_game, start};

fn e<T: std::fmt::Debug>(x: T) -> String {
    format!("{x:?}")
}

/// ロールに切り替えた接続で SQL を実行し、PostgreSQL の SQLSTATE（拒否は `42501`）を返す。
async fn run_as(pool: &PgPool, role: &str, sql: &str) -> Result<Option<String>, String> {
    let mut conn = pool.acquire().await.map_err(e)?;
    let conn: &mut PgConnection = &mut conn;
    sqlx::query(sqlx::AssertSqlSafe(format!("SET ROLE {role}")))
        .execute(&mut *conn)
        .await
        .map_err(e)?;
    let result = sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()))
        .execute(&mut *conn)
        .await;
    sqlx::query("RESET ROLE")
        .execute(&mut *conn)
        .await
        .map_err(e)?;
    Ok(match result {
        Ok(_) => None,
        Err(sqlx::Error::Database(db)) => db.code().map(|c| c.to_string()),
        Err(other) => return Err(e(other)),
    })
}

async fn seed(pool: &PgPool) -> Result<Uuid, String> {
    let game = new_game(pool).await?;
    sqlx::query("INSERT INTO events (event_id, game_id, stream_type, stream_version, event_type, schema_version, payload, actor_kind, correlation_id, command_id, occurred_at) VALUES ($1, $2, 'GAME', 1, 'X', 1, '{}'::jsonb, 'ANONYMOUS', $1, $1, now())")
        .bind(Uuid::new_v4()).bind(game).execute(pool).await.map_err(e)?;
    sqlx::query("INSERT INTO game_join_codes (game_id, join_code) VALUES ($1, 'secretcode1')")
        .bind(game)
        .execute(pool)
        .await
        .map_err(e)?;
    Ok(game)
}

#[tokio::test]
async fn nf_s18__書き込みロールは_events_に追記できるが_更新_削除_全削除はできない()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let game = seed(&env.pool).await?;
    let insert = format!(
        "INSERT INTO events (event_id, game_id, stream_type, stream_version, event_type, schema_version, payload, actor_kind, correlation_id, command_id, occurred_at) VALUES ('{0}', '{1}', 'GAME', 2, 'X', 1, '{{}}'::jsonb, 'ANONYMOUS', '{0}', '{0}', now())",
        Uuid::new_v4(),
        game
    );
    assert_eq!(
        run_as(&env.pool, "beergame_writer", &insert).await?,
        None,
        "追記はできる"
    );
    for sql in [
        "UPDATE events SET event_type = 'Y'",
        "DELETE FROM events",
        "TRUNCATE events",
        "DELETE FROM game_roots",
        "TRUNCATE game_roots",
    ] {
        assert_eq!(
            run_as(&env.pool, "beergame_writer", sql).await?.as_deref(),
            Some("42501"),
            "{sql} は拒否される"
        );
    }
    // 投影・周辺ストアは読み書きできる
    assert_eq!(
        run_as(
            &env.pool,
            "beergame_writer",
            "DELETE FROM lobby_participants"
        )
        .await?,
        None
    );
    Ok(())
}

#[tokio::test]
async fn nf_s18__観察者は_3_表だけを読め_参加コードと役割別の表には届かない() -> Result<(), String>
{
    let Some(env) = start().await? else {
        return Ok(());
    };
    seed(&env.pool).await?;
    for table in ["game_overview", "session_overview", "week_team_totals"] {
        assert_eq!(
            run_as(
                &env.pool,
                "beergame_observer",
                &format!("SELECT * FROM {table}")
            )
            .await?,
            None,
            "{table}"
        );
    }
    for table in [
        "game_join_codes",
        "role_current_states",
        "current_decisions",
        "week_role_results",
        "lobby_participants",
        "events",
        "credentials",
        "display_profiles",
    ] {
        assert_eq!(
            run_as(
                &env.pool,
                "beergame_observer",
                &format!("SELECT * FROM {table}")
            )
            .await?
            .as_deref(),
            Some("42501"),
            "{table} は読めない"
        );
    }
    assert_eq!(
        run_as(
            &env.pool,
            "beergame_observer",
            "INSERT INTO game_overview DEFAULT VALUES"
        )
        .await?
        .as_deref(),
        Some("42501")
    );
    Ok(())
}

#[tokio::test]
async fn nf_s18__読み取りロールは投影を読めるが_events_と資格は読めず_書けない()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    seed(&env.pool).await?;
    assert_eq!(
        run_as(
            &env.pool,
            "beergame_reader",
            "SELECT * FROM game_join_codes"
        )
        .await?,
        None
    );
    assert_eq!(
        run_as(&env.pool, "beergame_reader", "SELECT * FROM events")
            .await?
            .as_deref(),
        Some("42501")
    );
    assert_eq!(
        run_as(&env.pool, "beergame_reader", "SELECT * FROM credentials")
            .await?
            .as_deref(),
        Some("42501")
    );
    assert_eq!(
        run_as(&env.pool, "beergame_reader", "DELETE FROM game_join_codes")
            .await?
            .as_deref(),
        Some("42501")
    );
    Ok(())
}

#[tokio::test]
async fn nf_s18__削除ロールは_events_の_DELETE_権限が無くても_ゲームの連鎖削除ができる()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let game = seed(&env.pool).await?;
    assert_eq!(
        run_as(&env.pool, "beergame_deleter", "DELETE FROM events")
            .await?
            .as_deref(),
        Some("42501"),
        "events を直接は消せない"
    );
    assert_eq!(
        run_as(
            &env.pool,
            "beergame_deleter",
            &format!("DELETE FROM game_roots WHERE game_id = '{game}'")
        )
        .await?,
        None
    );
    let left: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM events WHERE game_id = $1) + (SELECT count(*) FROM game_join_codes WHERE game_id = $1)")
        .bind(game).fetch_one(&env.pool).await.map_err(e)?;
    assert_eq!(left, 0, "連鎖削除で全表から消える");
    Ok(())
}
