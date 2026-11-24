//! 投影の保守（B13。NF-R15）。投影は `events` からいつでも作り直せる。
//! ポート `ProjectionMaintenance` は、1 ゲームの再構築と整合の検査を、永続化の側で行う（排他のロックの下で、1 トランザクション）。
//! ここの関数は、全ゲームを 1 ゲームずつ順に回し、1 ゲームの失敗が他のゲームに波及しないようにする。

use std::future::Future;

use beergame_domain::GameId;

use crate::AppFailure;

/// 1 ゲームの再構築の結果。`changed_rows` は、再構築の前後で変わった投影の行数（0 なら、元と一致していた）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RebuildOutcome {
    pub game_id: GameId,
    pub events: usize,
    pub rows: usize,
    pub changed_rows: usize,
}

/// 投影と、イベントから作り直した内容の食い違い。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Inconsistency {
    /// 進んだ版の記録（`projection_checkpoints`）が、イベントの最後の版と違う。記録が無いときは `projected` が `None`。
    CheckpointDrift {
        stream: String,
        projected: Option<i64>,
        head: i64,
    },
    /// 投影の表の行が、作り直した行と違う。`missing` は作り直した行にあって投影に無い行、`unexpected` は投影にだけある行。
    RowDrift {
        table: String,
        missing: usize,
        unexpected: usize,
    },
}

/// 投影の保守のポート。いずれも、ゲーム単位の排他のロックを待ちの上限まで待つ（取れなければ `RetryExhausted`）。
pub trait ProjectionMaintenance: Sync {
    fn games(&self) -> impl Future<Output = Result<Vec<GameId>, AppFailure>> + Send;

    /// 投影の行をすべて消し、イベントから作り直して確定する。
    fn rebuild(
        &self,
        game_id: GameId,
    ) -> impl Future<Output = Result<RebuildOutcome, AppFailure>> + Send;

    /// 作り直した結果と比べる。投影は変えない（比べたあとで取り消す）。
    fn verify(
        &self,
        game_id: GameId,
    ) -> impl Future<Output = Result<Vec<Inconsistency>, AppFailure>> + Send;
}

/// 全ゲームの再構築の結果。
#[derive(Debug, Default)]
pub struct RebuildReport {
    pub rebuilt: Vec<RebuildOutcome>,
    pub failed: Vec<(GameId, AppFailure)>,
}

/// 全ゲームの整合検査の結果。
#[derive(Debug, Default)]
pub struct VerifyReport {
    pub checked: usize,
    pub inconsistent: Vec<(GameId, Vec<Inconsistency>)>,
    /// ロックを取れず、検査できなかったゲーム（不一致には数えない）。
    pub skipped: Vec<GameId>,
    pub failed: Vec<(GameId, AppFailure)>,
}

/// 再構築する。`targets` が空なら、すべてのゲーム。一覧を読めないときだけ `Err`（1 ゲームの失敗は `failed`）。
///
/// # Errors
/// ゲームの一覧を読めないとき。
pub async fn rebuild_projections<P: ProjectionMaintenance>(
    port: &P,
    targets: &[GameId],
) -> Result<RebuildReport, AppFailure> {
    let mut report = RebuildReport::default();
    for game_id in target_games(port, targets).await? {
        match port.rebuild(game_id).await {
            Ok(outcome) => report.rebuilt.push(outcome),
            Err(failure) => report.failed.push((game_id, failure)),
        }
    }
    Ok(report)
}

/// 対象のゲーム。指定が無ければ、すべてのゲーム（作成の順）。指定があれば、その順のまま。
async fn target_games<P: ProjectionMaintenance>(
    port: &P,
    targets: &[GameId],
) -> Result<Vec<GameId>, AppFailure> {
    if targets.is_empty() {
        port.games().await
    } else {
        Ok(targets.to_vec())
    }
}

/// 整合を検査する。`targets` が空なら、すべてのゲーム。
///
/// # Errors
/// ゲームの一覧を読めないとき。
pub async fn verify_projections<P: ProjectionMaintenance>(
    port: &P,
    targets: &[GameId],
) -> Result<VerifyReport, AppFailure> {
    let mut report = VerifyReport::default();
    for game_id in target_games(port, targets).await? {
        match port.verify(game_id).await {
            Ok(findings) => {
                report.checked += 1;
                if !findings.is_empty() {
                    report.inconsistent.push((game_id, findings));
                }
            }
            // ロックを取れなかった（再構築・コマンドの最中）。不一致ではない
            Err(AppFailure::RetryExhausted) => report.skipped.push(game_id),
            Err(failure) => report.failed.push((game_id, failure)),
        }
    }
    Ok(report)
}

#[cfg(test)]
#[allow(non_snake_case)] // 理由: RT1 の命名（承認済み）の `__` を使うため。
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// ゲームごとの結果を差し込める偽のポート。
    struct Fake {
        games: Result<Vec<GameId>, ()>,
        rebuild: HashMap<u128, Result<usize, AppFailure>>,
        verify: HashMap<u128, Result<Vec<Inconsistency>, AppFailure>>,
    }

    fn id(n: u128) -> GameId {
        GameId::new(n)
    }

    impl ProjectionMaintenance for Fake {
        async fn games(&self) -> Result<Vec<GameId>, AppFailure> {
            self.games.clone().map_err(|()| AppFailure::RetryExhausted)
        }

        async fn rebuild(&self, game_id: GameId) -> Result<RebuildOutcome, AppFailure> {
            match self.rebuild.get(&game_id.get()) {
                Some(Ok(changed)) => Ok(RebuildOutcome {
                    game_id,
                    events: 3,
                    rows: 10,
                    changed_rows: *changed,
                }),
                Some(Err(e)) => Err(e.clone()),
                None => Ok(RebuildOutcome {
                    game_id,
                    events: 1,
                    rows: 1,
                    changed_rows: 0,
                }),
            }
        }

        async fn verify(&self, game_id: GameId) -> Result<Vec<Inconsistency>, AppFailure> {
            self.verify
                .get(&game_id.get())
                .cloned()
                .unwrap_or(Ok(Vec::new()))
        }
    }

    fn fake(games: &[u128]) -> Fake {
        Fake {
            games: Ok(games.iter().map(|n| id(*n)).collect()),
            rebuild: HashMap::new(),
            verify: HashMap::new(),
        }
    }

    #[tokio::test]
    async fn nf_r15__対象を指定しなければすべてのゲームを再構築する() -> Result<(), String> {
        let report = rebuild_projections(&fake(&[1, 2, 3]), &[])
            .await
            .map_err(|e| format!("{e:?}"))?;
        assert_eq!(report.rebuilt.len(), 3);
        assert!(report.failed.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn nf_r15__対象を指定すればそのゲームだけを再構築する() -> Result<(), String> {
        let report = rebuild_projections(&fake(&[1, 2, 3]), &[id(2)])
            .await
            .map_err(|e| format!("{e:?}"))?;
        let ids: Vec<u128> = report.rebuilt.iter().map(|o| o.game_id.get()).collect();
        assert_eq!(ids, vec![2]);
        Ok(())
    }

    #[tokio::test]
    async fn nf_r15__1_ゲームの再構築の失敗は他のゲームに波及しない() -> Result<(), String> {
        let mut port = fake(&[1, 2, 3]);
        port.rebuild.insert(2, Err(AppFailure::RetryExhausted));
        let report = rebuild_projections(&port, &[])
            .await
            .map_err(|e| format!("{e:?}"))?;
        assert_eq!(report.rebuilt.len(), 2);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].0, id(2));
        Ok(())
    }

    #[tokio::test]
    async fn nf_r15__ゲームの一覧を読めなければ再構築は失敗する() {
        let mut port = fake(&[]);
        port.games = Err(());
        assert!(rebuild_projections(&port, &[]).await.is_err());
        assert!(verify_projections(&port, &[]).await.is_err());
    }

    #[tokio::test]
    async fn nf_r15__検査は不一致のゲームを報告し_ロックを取れないゲームは不一致に数えない()
    -> Result<(), String> {
        let mut port = fake(&[1, 2, 3, 4]);
        let drift = Inconsistency::RowDrift {
            table: "game_overview".to_owned(),
            missing: 1,
            unexpected: 0,
        };
        port.verify.insert(2, Ok(vec![drift.clone()]));
        port.verify.insert(3, Err(AppFailure::RetryExhausted));
        port.verify.insert(
            4,
            Err(AppFailure::Persistence(crate::PersistenceFailure::Storage(
                "x".into(),
            ))),
        );
        let report = verify_projections(&port, &[])
            .await
            .map_err(|e| format!("{e:?}"))?;
        assert_eq!(report.checked, 2, "検査できたのは 1 と 2");
        assert_eq!(report.inconsistent, vec![(id(2), vec![drift])]);
        assert_eq!(report.skipped, vec![id(3)]);
        assert_eq!(report.failed.len(), 1);
        Ok(())
    }
}
