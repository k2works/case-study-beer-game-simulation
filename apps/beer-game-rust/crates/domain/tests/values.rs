// 理由: simulate_week_golden.rs と同じ（RT1 の `__` を使うため）。
#![allow(non_snake_case)]

//! 値オブジェクトの検証（AC1.1.2・AC1.1.4。誤りは項目ごとにすべて集める）。

use beergame_domain::{CostPolicy, DemandSeries, Money, Quantity, ValidationError, Week};

fn week(n: i64) -> Result<Week, String> {
    Week::of(n).map_err(|e| format!("{e:?}"))
}

#[test]
fn ac1_1_2__発注量は0から1000まで() {
    assert!(Quantity::of(0).is_ok());
    assert!(Quantity::of(1000).is_ok());
    assert_eq!(
        Quantity::of(1001),
        Err(ValidationError::QuantityOutOfRange {
            actual: 1001,
            max: 1000
        })
    );
    assert!(Quantity::of(-1).is_err());
}

#[test]
fn ac1_1_2__週は1から50まで() {
    assert!(Week::of(1).is_ok());
    assert!(Week::of(50).is_ok());
    assert!(Week::of(0).is_err());
    assert!(Week::of(51).is_err());
}

#[test]
fn ac1_1_2__最後の週の次は無い() -> Result<(), String> {
    assert_eq!(week(49)?.next(), Some(week(50)?));
    assert_eq!(week(50)?.next(), None);
    Ok(())
}

#[test]
fn ac1_1_2__需要系列の範囲外は対象の週ごとにすべて集める() -> Result<(), String> {
    let result = DemandSeries::of(&[4, 1001, 4, -1], week(4)?);
    let weeks: Vec<usize> = result
        .err()
        .unwrap_or_default()
        .iter()
        .filter_map(|e| {
            if let ValidationError::DemandSeriesInvalid { week_index, .. } = e {
                Some(*week_index)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(weeks, vec![2, 4]);
    Ok(())
}

#[test]
fn ac1_1_2__需要系列が最終週に届かなければ誤りになる() -> Result<(), String> {
    let result = DemandSeries::of(&[4, 4], week(3)?);
    assert!(matches!(
        result.err().as_deref(),
        Some([ValidationError::DemandSeriesInvalid { week_index: 3, .. }])
    ));
    Ok(())
}

#[test]
fn ac1_1_4__費用の単価の誤りは項目ごとにすべて集める() {
    assert_eq!(
        CostPolicy::of(-1, -2),
        Err(vec![
            ValidationError::MoneyNegative { actual: -1 },
            ValidationError::MoneyNegative { actual: -2 }
        ])
    );
    assert!(CostPolicy::of(50, 100).is_ok());
    assert_eq!(
        Money::of(-1),
        Err(ValidationError::MoneyNegative { actual: -1 })
    );
}
