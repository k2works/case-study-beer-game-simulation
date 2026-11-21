//! 入力の形の誤り。境界で値オブジェクトを作るときに、可能な限りすべて集めて返す。

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ValidationError {
    QuantityOutOfRange {
        actual: i64,
        max: u32,
    },
    WeekOutOfRange {
        actual: i64,
        max: u8,
    },
    UnitsNegative {
        actual: i64,
    },
    MoneyNegative {
        actual: i64,
    },
    /// 需要系列の誤り。`week_index` は対象の週（1 始まり）で、利用者に修正すべき週を示す（AC1.1.2）。
    DemandSeriesInvalid {
        week_index: usize,
        reason: &'static str,
    },
}
