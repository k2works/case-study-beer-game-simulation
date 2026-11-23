//! 起動モード `rebuild-projections [ゲーム ID ...]` と `verify-projections [ゲーム ID ...]`（NF-R15）。
//! 引数の解釈と終了コードを、純粋な関数に分ける（infrastructure: 失敗 1、一覧を読めない 70、形が不正なゲーム ID 64）。

use beergame_application::{RebuildReport, VerifyReport};
use beergame_domain::GameId;

/// 形が不正なゲーム ID（引数の誤り）。
pub const EXIT_USAGE: u8 = 64;
/// ゲームの一覧を読めない。
pub const EXIT_UNAVAILABLE: u8 = 70;

/// 引数のゲーム ID（UUID）。空なら、すべてのゲーム。
///
/// # Errors
/// UUID の形でない引数があるとき（その引数を返す）。
pub fn parse_game_ids(args: &[String]) -> Result<Vec<GameId>, String> {
    args.iter()
        .map(|arg| {
            uuid::Uuid::parse_str(arg)
                .map(|id| GameId::new(id.as_u128()))
                .map_err(|_| arg.clone())
        })
        .collect()
}

/// モードを実行する。マイグレーションは行わない（スキーマの適用は `migrate` モードの責務。再構築は、その後に行う）。
pub async fn run(mode: &str, database_url: &str, args: &[String]) -> std::process::ExitCode {
    use std::process::ExitCode;

    let Ok(targets) = parse_game_ids(args) else {
        tracing::error!("形が不正なゲーム ID がある");
        return ExitCode::from(EXIT_USAGE);
    };
    let Ok(pool) = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(database_url)
        .await
    else {
        tracing::error!("データベースに接続できません");
        return ExitCode::from(EXIT_UNAVAILABLE);
    };
    let port = beergame_adapter_persistence::PgProjectionMaintenance::new(pool);
    if mode == "rebuild-projections" {
        match beergame_application::rebuild_projections(&port, &targets).await {
            Ok(report) => {
                for outcome in &report.rebuilt {
                    tracing::info!(
                        game_id = %uuid::Uuid::from_u128(outcome.game_id.get()),
                        events = outcome.events,
                        rows = outcome.rows,
                        changed_rows = outcome.changed_rows,
                        "再構築した"
                    );
                }
                for (game, failure) in &report.failed {
                    tracing::error!(
                        game_id = %uuid::Uuid::from_u128(game.get()),
                        ?failure,
                        "再構築できなかった"
                    );
                }
                ExitCode::from(rebuild_exit_code(&report))
            }
            Err(_) => ExitCode::from(EXIT_UNAVAILABLE),
        }
    } else {
        match beergame_application::verify_projections(&port, &targets).await {
            Ok(report) => {
                tracing::info!(
                    checked = report.checked,
                    inconsistent = report.inconsistent.len(),
                    skipped = report.skipped.len(),
                    failed = report.failed.len(),
                    "整合を検査した"
                );
                for (game, findings) in &report.inconsistent {
                    tracing::error!(
                        game_id = %uuid::Uuid::from_u128(game.get()),
                        ?findings,
                        "投影が不一致"
                    );
                }
                ExitCode::from(verify_exit_code(&report))
            }
            Err(_) => ExitCode::from(EXIT_UNAVAILABLE),
        }
    }
}

/// 再構築の終了コード。再構築できなかったゲームがあれば 1。
#[must_use]
pub fn rebuild_exit_code(report: &RebuildReport) -> u8 {
    u8::from(!report.failed.is_empty())
}

/// 検査の終了コード。不一致・検査の失敗があれば 1（ロックを取れず検査できなかったゲームは、不一致に数えない）。
#[must_use]
pub fn verify_exit_code(report: &VerifyReport) -> u8 {
    u8::from(!report.inconsistent.is_empty() || !report.failed.is_empty())
}

#[cfg(test)]
#[allow(non_snake_case)] // 理由: RT1 の命名（承認済み）の `__` を使うため。
mod tests {
    use super::*;
    use beergame_application::{AppFailure, Inconsistency, RebuildOutcome};

    fn game(n: u128) -> GameId {
        GameId::new(n)
    }

    #[test]
    fn nf_r15__引数が無ければすべてのゲームを表す空の一覧になる() {
        assert_eq!(parse_game_ids(&[]), Ok(Vec::new()));
    }

    #[test]
    fn nf_r15__引数のゲーム_ID_は_UUID_として読む() {
        let args = vec![
            "00000000-0000-0000-0000-000000000001".to_owned(),
            "00000000-0000-0000-0000-00000000000a".to_owned(),
        ];
        assert_eq!(parse_game_ids(&args), Ok(vec![game(1), game(10)]));
    }

    #[test]
    fn nf_r15__形が不正なゲーム_ID_は_その引数を返して拒む() {
        let args = vec!["not-a-uuid".to_owned()];
        assert_eq!(parse_game_ids(&args), Err("not-a-uuid".to_owned()));
    }

    #[test]
    fn nf_r15__再構築は失敗したゲームがあれば_1_なければ_0() {
        let ok = RebuildReport {
            rebuilt: vec![RebuildOutcome {
                game_id: game(1),
                events: 1,
                rows: 1,
                changed_rows: 0,
            }],
            failed: Vec::new(),
        };
        assert_eq!(rebuild_exit_code(&ok), 0);
        let failed = RebuildReport {
            rebuilt: Vec::new(),
            failed: vec![(game(2), AppFailure::RetryExhausted)],
        };
        assert_eq!(rebuild_exit_code(&failed), 1);
    }

    #[test]
    fn nf_r15__検査は不一致か失敗があれば_1_ロックを取れなかっただけなら_0() {
        let clean = VerifyReport {
            checked: 2,
            skipped: vec![game(3)],
            ..VerifyReport::default()
        };
        assert_eq!(verify_exit_code(&clean), 0);
        let drift = Inconsistency::RowDrift {
            table: "game_overview".to_owned(),
            missing: 1,
            unexpected: 0,
        };
        let inconsistent = VerifyReport {
            checked: 1,
            inconsistent: vec![(game(1), vec![drift])],
            ..VerifyReport::default()
        };
        assert_eq!(verify_exit_code(&inconsistent), 1);
        let failed = VerifyReport {
            failed: vec![(game(2), AppFailure::RetryExhausted)],
            ..VerifyReport::default()
        };
        assert_eq!(verify_exit_code(&failed), 1);
    }
}
