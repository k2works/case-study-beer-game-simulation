//! 値オブジェクト。newtype（フィールド非公開）とスマートコンストラクタで、不正な値を作れなくする。

use crate::error::ValidationError;

/// 発注数・生産要請数。0〜1000 の整数（BR-10）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Quantity(u32);

impl Quantity {
    pub const MAX: u32 = 1000;

    /// # Errors
    /// 0〜1000 の範囲外のとき `QuantityOutOfRange`。
    pub fn of(n: i64) -> Result<Self, ValidationError> {
        u32::try_from(n)
            .ok()
            .filter(|v| *v <= Self::MAX)
            .map(Quantity)
            .ok_or(ValidationError::QuantityOutOfRange {
                actual: n,
                max: Self::MAX,
            })
    }

    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }

    #[must_use]
    pub const fn to_units(self) -> Units {
        Units(self.0)
    }
}

/// 上限のない非負の数量。在庫・受注残・出荷・待ち行列の中身に使う。
/// 発注（[`Quantity`]）は 0〜1000 だが、受注残の持ち越しなどで在庫や出荷は 1000 を超えうる。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Units(u32);

impl Units {
    pub const ZERO: Units = Units(0);

    #[must_use]
    pub const fn new(n: u32) -> Self {
        Units(n)
    }

    /// # Errors
    /// 負数、または `u32` に収まらないとき `UnitsNegative`。
    pub fn of(n: i64) -> Result<Self, ValidationError> {
        u32::try_from(n)
            .map(Units)
            .map_err(|_| ValidationError::UnitsNegative { actual: n })
    }

    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }

    /// 足した結果。上限を超える場合は上限に張り付く（黙ってあふれない）。
    #[must_use]
    pub const fn plus(self, other: Units) -> Units {
        Units(self.0.saturating_add(other.0))
    }

    /// 引いた結果が負なら 0（`max(0, self - other)`。BR-08）。
    #[must_use]
    pub const fn minus_to_zero(self, other: Units) -> Units {
        Units(self.0.saturating_sub(other.0))
    }
}

/// 週。1〜50（AC1.1.5）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Week(u8);

impl Week {
    pub const MIN: u8 = 1;
    pub const MAX: u8 = 50;
    pub const FIRST: Week = Week(Self::MIN);

    /// # Errors
    /// 1〜50 の範囲外のとき `WeekOutOfRange`。
    pub fn of(n: i64) -> Result<Self, ValidationError> {
        u8::try_from(n)
            .ok()
            .filter(|v| (Self::MIN..=Self::MAX).contains(v))
            .map(Week)
            .ok_or(ValidationError::WeekOutOfRange {
                actual: n,
                max: Self::MAX,
            })
    }

    #[must_use]
    pub const fn get(self) -> u8 {
        self.0
    }

    /// 次の週。最後の週（50）の次は無い。
    #[must_use]
    pub const fn next(self) -> Option<Week> {
        if self.0 < Self::MAX {
            Some(Week(self.0 + 1))
        } else {
            None
        }
    }
}

/// 金額。最小単位（セント）の整数で持ち、小数を持たない。負数は不可。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Money(i64);

impl Money {
    pub const ZERO: Money = Money(0);

    /// 非負の整数から作る（負数になり得ないので失敗しない）。
    #[must_use]
    pub const fn new(minor: u32) -> Self {
        Money(minor as i64)
    }

    /// # Errors
    /// 負数のとき `MoneyNegative`。
    pub fn of(minor: i64) -> Result<Self, ValidationError> {
        if minor >= 0 {
            Ok(Money(minor))
        } else {
            Err(ValidationError::MoneyNegative { actual: minor })
        }
    }

    #[must_use]
    pub const fn minor(self) -> i64 {
        self.0
    }

    /// 足した結果。上限を超える場合は上限に張り付く。
    #[must_use]
    pub const fn plus(self, other: Money) -> Money {
        Money(self.0.saturating_add(other.0))
    }

    /// 単価 × 数量。上限を超える場合は上限に張り付く。
    #[must_use]
    pub fn times(self, units: Units) -> Money {
        Money(self.0.saturating_mul(i64::from(units.0)))
    }
}
