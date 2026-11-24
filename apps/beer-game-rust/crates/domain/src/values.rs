//! 値オブジェクト。newtype（フィールド非公開）とスマートコンストラクタで、不正な値を作れなくする。

use crate::error::ValidationError;

/// 発注数・生産要請数。0〜1000 の整数（BR-10）。
/// @term 発注量 | 各週に、役割が上流へ注文する数量。0〜1000 の整数 | BR-10
/// @landmark ddd 戦術的設計 | 値オブジェクト。範囲を検証するスマートコンストラクタで作り、フィールドを公開しない。不正な値は、型として作れない
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
/// @term 週 | ゲームの進行の単位。1〜50 の整数。週ごとに、4 役割の発注量を確定して在庫・受注残・費用を更新する | AC1.1.5
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

/// 表示名。前後の空白を除いて 1〜80 文字（Unicode のコードポイント数）。イベントには入れない。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisplayName(String);

impl DisplayName {
    pub const MAX_LENGTH: usize = 80;

    /// # Errors
    /// 前後の空白を除いた文字数が 1〜80 でないとき `DisplayNameInvalid`。
    pub fn of(raw: &str) -> Result<Self, ValidationError> {
        let trimmed = raw.trim();
        let length = trimmed.chars().count();
        if (1..=Self::MAX_LENGTH).contains(&length) {
            Ok(DisplayName(trimmed.to_owned()))
        } else {
            Err(ValidationError::DisplayNameInvalid { length })
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 参加コード。推測困難な乱数から作る 8 文字以上の文字列（生成は境界が行い、ドメインは長さだけを検証する）。
#[derive(Clone, PartialEq, Eq)]
pub struct JoinCode(String);

impl JoinCode {
    pub const MIN_LENGTH: usize = 8;

    /// # Errors
    /// 8 文字に満たないとき `JoinCodeInvalid`。
    pub fn of(raw: &str) -> Result<Self, ValidationError> {
        let length = raw.chars().count();
        if length >= Self::MIN_LENGTH {
            Ok(JoinCode(raw.to_owned()))
        } else {
            Err(ValidationError::JoinCodeInvalid { length })
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 秘密に準じる値なので、`Debug` では中身を出さない（ログ・テスト出力への漏れを防ぐ）。
impl std::fmt::Debug for JoinCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("JoinCode(***)")
    }
}

/// 保持日数。1〜3650。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetentionDays(u16);

impl RetentionDays {
    pub const MIN: u16 = 1;
    pub const MAX: u16 = 3650;

    /// # Errors
    /// 1〜3650 の範囲外のとき `RetentionOutOfRange`。
    pub fn of(n: i64) -> Result<Self, ValidationError> {
        u16::try_from(n)
            .ok()
            .filter(|v| (Self::MIN..=Self::MAX).contains(v))
            .map(RetentionDays)
            .ok_or(ValidationError::RetentionOutOfRange { actual: n })
    }

    #[must_use]
    pub const fn get(self) -> u16 {
        self.0
    }
}

/// 意思決定の版。役割ごと・週ごとに 0 から始まり、保存のたびに 1 増える（ストリームの版とは別）。
/// @term 意思決定の版 | 役割ごと・週ごとの入力の版。保存のたびに 1 増え、古い画面からの保存や確定を拒否する根拠になる（ストリームの版とは別） | ドメインモデル D10
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct DecisionVersion(u32);

impl DecisionVersion {
    pub const ZERO: DecisionVersion = DecisionVersion(0);

    #[must_use]
    pub const fn new(n: u32) -> Self {
        DecisionVersion(n)
    }

    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }

    #[must_use]
    pub const fn next(self) -> DecisionVersion {
        DecisionVersion(self.0.saturating_add(1))
    }
}

/// ゲームの識別子。セッションの識別子も同じ値（1 ゲーム 1 セッション）。UUID の 128 ビット値で、変換は境界が行う。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct GameId(u128);

impl GameId {
    #[must_use]
    pub const fn new(n: u128) -> Self {
        GameId(n)
    }

    #[must_use]
    pub const fn get(self) -> u128 {
        self.0
    }
}

/// 参加者の識別子。UUID の 128 ビット値で、変換は境界が行う。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ParticipantId(u128);

impl ParticipantId {
    #[must_use]
    pub const fn new(n: u128) -> Self {
        ParticipantId(n)
    }

    #[must_use]
    pub const fn get(self) -> u128 {
        self.0
    }
}

/// 観察用の招待の識別子。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct InvitationId(u128);

impl InvitationId {
    #[must_use]
    pub const fn new(n: u128) -> Self {
        InvitationId(n)
    }

    #[must_use]
    pub const fn get(self) -> u128 {
        self.0
    }
}

/// 観察者の識別子。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ObserverId(u128);

impl ObserverId {
    #[must_use]
    pub const fn new(n: u128) -> Self {
        ObserverId(n)
    }

    #[must_use]
    pub const fn get(self) -> u128 {
        self.0
    }
}

/// 時刻（UNIX エポックからのミリ秒）。時計は読まず、コマンドの値として受け取る。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Instant(i64);

impl Instant {
    #[must_use]
    pub const fn from_epoch_millis(ms: i64) -> Self {
        Instant(ms)
    }

    #[must_use]
    pub const fn epoch_millis(self) -> i64 {
        self.0
    }
}
