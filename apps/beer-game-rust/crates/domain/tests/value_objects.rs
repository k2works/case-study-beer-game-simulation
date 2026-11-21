// 理由: RT1 の命名（承認済み）の `__` を使うため（simulate_week_golden.rs と同じ）。
#![allow(non_snake_case)]

//! 値オブジェクトと設定の検証（AC1.1.1、AC1.1.2、AC1.2.1）。誤りは項目ごとにすべて集める。

use beergame_domain::{
    CommitMode, DecisionVersion, DisplayName, ErrorCategory, GameError, GameId, GameSettings,
    Instant, JoinCode, Money, ParticipantId, Quantity, RetentionDays, Role, SessionError,
    StartError, Units, ValidationError, Week,
};

#[test]
fn ac1_2_1__表示名は前後の空白を除いて1から80文字() {
    assert_eq!(
        DisplayName::of("  太郎  ").map(|n| n.as_str().to_owned()),
        Ok("太郎".to_owned())
    );
    assert!(DisplayName::of(&"あ".repeat(80)).is_ok());
    assert_eq!(
        DisplayName::of(&"あ".repeat(81)),
        Err(ValidationError::DisplayNameInvalid { length: 81 })
    );
    assert_eq!(
        DisplayName::of("   "),
        Err(ValidationError::DisplayNameInvalid { length: 0 })
    );
}

#[test]
fn ac1_1_1__参加コードは8文字以上で_Debug_に中身を出さない() -> Result<(), String> {
    assert_eq!(
        JoinCode::of("short"),
        Err(ValidationError::JoinCodeInvalid { length: 5 })
    );
    let code = JoinCode::of("abcd1234").map_err(|e| format!("{e:?}"))?;
    assert_eq!(code.as_str(), "abcd1234");
    assert!(!format!("{code:?}").contains("abcd1234"));
    Ok(())
}

#[test]
fn ac1_1_1__保持日数は1から3650まで() -> Result<(), String> {
    assert_eq!(
        RetentionDays::of(30).map_err(|e| format!("{e:?}"))?.get(),
        30
    );
    assert!(RetentionDays::of(1).is_ok());
    assert!(RetentionDays::of(3650).is_ok());
    assert_eq!(
        RetentionDays::of(0),
        Err(ValidationError::RetentionOutOfRange { actual: 0 })
    );
    assert!(RetentionDays::of(3651).is_err());
    Ok(())
}

#[test]
fn ac2_2_2__意思決定の版は保存のたびに1増える() {
    assert_eq!(DecisionVersion::ZERO.next(), DecisionVersion::new(1));
    assert_eq!(DecisionVersion::new(8).next().get(), 9);
}

#[test]
fn ac2_3_4__数量と金額と時刻と識別子は値を取り出せる() -> Result<(), String> {
    assert_eq!(Quantity::of(7).map_err(|e| format!("{e:?}"))?.get(), 7);
    assert_eq!(
        Quantity::of(7).map_err(|e| format!("{e:?}"))?.to_units(),
        Units::new(7)
    );
    assert_eq!(Units::of(5), Ok(Units::new(5)));
    assert_eq!(
        Units::of(-1),
        Err(ValidationError::UnitsNegative { actual: -1 })
    );
    assert_eq!(Units::new(5).get(), 5);
    assert_eq!(Money::new(50).minor(), 50);
    assert_eq!(Money::of(50), Ok(Money::new(50)));
    assert_eq!(Instant::from_epoch_millis(9).epoch_millis(), 9);
    assert_eq!(GameId::new(3).get(), 3);
    assert_eq!(ParticipantId::new(4).get(), 4);
    assert_eq!(Week::of(7).map_err(|e| format!("{e:?}"))?.get(), 7);
    Ok(())
}

#[test]
fn ac1_1_1__単位の足し算と引き算はあふれず_負にならない() {
    assert_eq!(
        Units::new(u32::MAX).plus(Units::new(1)),
        Units::new(u32::MAX)
    );
    assert_eq!(Units::new(3).minus_to_zero(Units::new(5)), Units::ZERO);
    // 金額もあふれず、上限に張り付く（負にならない）
    assert!(
        Money::new(u32::MAX)
            .times(Units::new(u32::MAX))
            .plus(Money::new(1))
            .minor()
            > 0
    );
}

#[test]
fn ac1_1_1__キット準拠の設定は最終週と需要系列と確定方式を持つ() -> Result<(), String> {
    let settings =
        GameSettings::kit(3, &[4, 4, 4], CommitMode::Manual).map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        settings.final_week,
        Week::of(3).map_err(|e| format!("{e:?}"))?
    );
    assert_eq!(settings.commit_mode, CommitMode::Manual);
    assert_eq!(settings.simulation().final_week, settings.final_week);
    Ok(())
}

#[test]
fn ac1_1_2__最終週と需要系列の誤りはすべて集めて返す() {
    // 最終週が範囲外でも、需要系列の各週の誤りも返す
    let errors = GameSettings::kit(51, &[4, 1001, -1], CommitMode::Manual)
        .err()
        .unwrap_or_default();
    assert_eq!(errors.len(), 3);
    assert!(matches!(
        errors.first(),
        Some(ValidationError::WeekOutOfRange { actual: 51, .. })
    ));
    // 最終週が正しく需要系列が短いだけなら、長さの誤り 1 件
    let short = GameSettings::kit(5, &[4, 4], CommitMode::Manual)
        .err()
        .unwrap_or_default();
    assert_eq!(short.len(), 1);
}

#[test]
fn 開始の誤りは_Game_と_Session_の_code_と_category_をそのまま返す() {
    let game = StartError::Game(GameError::StartConditionNotMet(vec![Role::Factory]));
    assert_eq!(game.code(), "game.start_condition_not_met");
    assert_eq!(game.category(), ErrorCategory::RuleViolation);
    let session = StartError::Session(SessionError::AlreadyStarted);
    assert_eq!(session.code(), "session.already_started");
    assert_eq!(session.category(), ErrorCategory::InvalidState);
}

#[test]
fn ac1_1_1__需要系列は整数の列として取り出せる() -> Result<(), String> {
    let week = Week::of(3).map_err(|e| format!("{e:?}"))?;
    let series =
        beergame_domain::DemandSeries::of(&[4, 8, 12], week).map_err(|e| format!("{e:?}"))?;
    assert_eq!(series.to_ints(), vec![4, 8, 12]);
    Ok(())
}
