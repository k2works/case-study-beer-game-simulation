//! 設定の値オブジェクト（費用方針・需要系列）。

use crate::error::ValidationError;
use crate::values::{Money, Quantity, Units, Week};

/// 費用方針。在庫と受注残の、1 単位 1 週あたりの単価（最小単位）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CostPolicy {
    pub holding: Money,
    pub backlog: Money,
}

impl CostPolicy {
    /// 複数の誤りは項目ごとにすべて集めて返す。
    ///
    /// # Errors
    /// 単価が負のとき、該当するすべての誤り。
    pub fn of(holding_minor: i64, backlog_minor: i64) -> Result<Self, Vec<ValidationError>> {
        match (Money::of(holding_minor), Money::of(backlog_minor)) {
            (Ok(holding), Ok(backlog)) => Ok(CostPolicy { holding, backlog }),
            (holding, backlog) => Err([holding, backlog]
                .into_iter()
                .filter_map(Result::err)
                .collect()),
        }
    }
}

/// 各週の顧客需要。週は 1 始まりで、系列の外の週は 0。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DemandSeries(Vec<Units>);

impl DemandSeries {
    const REASON_RANGE: &'static str = "需要は 0〜1000 の整数";
    const REASON_SHORT: &'static str = "需要系列が最終週に届かない";

    /// 各週の需要は 0〜1000、長さは `final_week` 以上（AC1.1.2）。
    /// 範囲外の誤りは対象週（1 始まり）ごとにすべて集める。各週が正しい場合だけ、長さを検査する。
    ///
    /// # Errors
    /// 範囲外の週すべて、または長さの不足。
    pub fn of(values: &[i64], final_week: Week) -> Result<Self, Vec<ValidationError>> {
        let parsed: Vec<Result<Units, ValidationError>> = values
            .iter()
            .enumerate()
            .map(|(index, n)| {
                Quantity::of(*n).map(Quantity::to_units).map_err(|_| {
                    ValidationError::DemandSeriesInvalid {
                        week_index: index.saturating_add(1),
                        reason: Self::REASON_RANGE,
                    }
                })
            })
            .collect();
        let errors: Vec<ValidationError> = parsed
            .iter()
            .filter_map(|r| r.as_ref().err().cloned())
            .collect();
        if !errors.is_empty() {
            return Err(errors);
        }
        let weeks: Vec<Units> = parsed.into_iter().filter_map(Result::ok).collect();
        if weeks.len() < usize::from(final_week.get()) {
            return Err(vec![ValidationError::DemandSeriesInvalid {
                week_index: weeks.len().saturating_add(1),
                reason: Self::REASON_SHORT,
            }]);
        }
        Ok(DemandSeries(weeks))
    }

    /// 系列そのもの（週 1 から順の整数）。永続化の往復（イベントの JSON への変換）に使う。
    #[must_use]
    pub fn to_ints(&self) -> Vec<i64> {
        self.0.iter().map(|u| i64::from(u.get())).collect()
    }

    /// その週の需要。系列の外は 0。
    #[must_use]
    pub fn at(&self, week: Week) -> Units {
        self.0
            .get(usize::from(week.get()).saturating_sub(1))
            .copied()
            .unwrap_or(Units::ZERO)
    }

    /// 次の週の需要（週は 1 始まりなので、0 始まりの添字としてそのまま次の週を指す）。
    #[must_use]
    pub fn after(&self, week: Week) -> Units {
        self.0
            .get(usize::from(week.get()))
            .copied()
            .unwrap_or(Units::ZERO)
    }
}
