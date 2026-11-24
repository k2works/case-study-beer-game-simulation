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
    /// 前後の空白を除いた長さ（文字数）が 1〜80 でない。
    DisplayNameInvalid {
        length: usize,
    },
    /// 参加コードが 8 文字に満たない。
    JoinCodeInvalid {
        length: usize,
    },
    /// 保持日数が 1〜3650 でない。
    RetentionOutOfRange {
        actual: i64,
    },
    /// カスタム条件の値が範囲外（整数）。`field` は条件の項目名（`conditions.<field>` として示す）。
    /// `role` は役割ごとの値（初期在庫）のときの対象。
    ConditionOutOfRange {
        field: &'static str,
        role: Option<crate::role::Role>,
        min: i64,
        max: i64,
    },
    /// 公開範囲が `TEAM_TOTAL`・`NONE` のどちらでもない。
    DisclosureInvalid,
    /// キット準拠の作成に、条件が付いている（カスタムで作成する）。
    ConditionsOnKit,
    /// 需要系列の誤り。`week_index` は対象の週（1 始まり）で、利用者に修正すべき週を示す（AC1.1.2）。
    DemandSeriesInvalid {
        week_index: usize,
        reason: &'static str,
    },
}
