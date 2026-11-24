// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! イベントの JSON 変換（往復）。ゲームの開始から最終週の確定までの全イベントが、変換して戻すと同じになる。

use beergame_adapter_persistence::{EventCodec, GameCodec, SessionCodec};
use beergame_domain::{
    Actor, CommitMode, DecisionVersion, DisplayName, GameCommand, GameId, GameSettings, GameState,
    Instant, JoinCode, ParticipantId, Quantity, RetentionDays, Role, RoleMap, SessionCommand,
    SessionState, StartGame, Week, decide_game, decide_session, evolve_game, evolve_session,
    start_game,
};

type R<T> = Result<T, String>;

fn e<T: std::fmt::Debug>(x: T) -> String {
    format!("{x:?}")
}

const GAME: GameId = GameId::new(0x1234_5678_9abc_def0_1234_5678_9abc_def0);

fn roundtrip<Ev: Clone + PartialEq + std::fmt::Debug>(
    codec: &impl EventCodec<Ev>,
    event: &Ev,
) -> R<()> {
    let (event_type, schema, payload) = codec.encode(event)?;
    let back = codec.decode(&event_type, schema, payload)?;
    if back == *event {
        Ok(())
    } else {
        Err(format!("往復で変わった: {event:?} -> {back:?}"))
    }
}

#[test]
fn ac2_3_4__ゲームの全イベントは_JSON_に変換して戻すと同じになる() -> R<()> {
    let at = Instant::from_epoch_millis(1_000);
    let expires = Instant::from_epoch_millis(9_000_000);
    let settings = GameSettings::kit(2, &[4, 8], CommitMode::Manual).map_err(e)?;
    let mut game = GameState::NotCreated;
    let mut game_events = Vec::new();
    let mut apply = |game: &mut GameState, command: GameCommand| -> R<()> {
        for event in decide_game(game, &command).map_err(e)? {
            game_events.push(event.clone());
            *game = evolve_game(game.clone(), &event).into_state();
        }
        Ok(())
    };
    apply(
        &mut game,
        GameCommand::CreateGame {
            actor: Actor::Anonymous,
            at,
            game_id: GAME,
            join_code: JoinCode::of("abcd1234").map_err(e)?,
            settings,
            retention_days: RetentionDays::of(30).map_err(e)?,
            facilitator_credential_expires_at: expires,
        },
    )?;
    for (n, role) in [
        (1_u128, Role::Factory),
        (2, Role::Distributor),
        (3, Role::Wholesaler),
        (4, Role::Retailer),
    ] {
        apply(
            &mut game,
            GameCommand::JoinGame {
                actor: Actor::Anonymous,
                at,
                participant_id: ParticipantId::new(n),
                display_name: DisplayName::of("参加者").map_err(e)?,
                credential_expires_at: expires,
            },
        )?;
        apply(
            &mut game,
            GameCommand::AssignRole {
                actor: Actor::Facilitator(GAME),
                at,
                participant_id: ParticipantId::new(n),
                role,
            },
        )?;
    }
    // 付け替え（RoleUnassigned）も通す
    apply(
        &mut game,
        GameCommand::AssignRole {
            actor: Actor::Facilitator(GAME),
            at,
            participant_id: ParticipantId::new(4),
            role: Role::Wholesaler,
        },
    )?;
    apply(
        &mut game,
        GameCommand::AssignRole {
            actor: Actor::Facilitator(GAME),
            at,
            participant_id: ParticipantId::new(4),
            role: Role::Retailer,
        },
    )?;
    let started = start_game(
        &game,
        &SessionState::NotStarted,
        &StartGame {
            actor: Actor::Facilitator(GAME),
            at,
        },
    )
    .map_err(e)?;
    game_events.extend(started.game.clone());
    for event in &game_events {
        roundtrip(&GameCodec, event)?;
    }

    // session: 開始 → 全役割の保存 → 確定（週 1）→ 保存 → 確定（最終週。SessionEnded）
    let mut session = SessionState::NotStarted;
    let mut session_events = started.session;
    for event in &session_events {
        session = evolve_session(session, event).into_state();
    }
    for week in [1_i64, 2] {
        for (n, role) in [
            (1_u128, Role::Factory),
            (2, Role::Distributor),
            (3, Role::Wholesaler),
            (4, Role::Retailer),
        ] {
            let command = SessionCommand::SaveDecision {
                actor: Actor::Participant(ParticipantId::new(n)),
                at,
                role,
                requested_week: Week::of(week).map_err(e)?,
                quantity: Quantity::of(4).map_err(e)?,
                expected_decision_version: DecisionVersion::ZERO,
            };
            for event in decide_session(&session, &command).map_err(e)? {
                session_events.push(event.clone());
                session = evolve_session(session, &event).into_state();
            }
        }
        let command = SessionCommand::CommitWeek {
            actor: Actor::Facilitator(GAME),
            at,
            requested_week: Week::of(week).map_err(e)?,
            basis: RoleMap::all(&DecisionVersion::new(1)),
        };
        for event in decide_session(&session, &command).map_err(e)? {
            session_events.push(event.clone());
            session = evolve_session(session, &event).into_state();
        }
    }
    if !matches!(session, SessionState::Ended(_)) {
        return Err("最終週の確定で終了していない".to_owned());
    }
    for event in &session_events {
        roundtrip(&SessionCodec, event)?;
    }
    export_golden(&game_events, &session_events)
}

/// 環境変数 `GOLDEN_EXPORT` があれば、現在の版が書くイベントの見本（golden）を、そのファイルへ書き出す（N-1 互換の確認の入力。
/// `scripts/n1-compat.sh` が使う）。無ければ何もしない。形: `[{"stream", "event_type", "schema_version", "payload"}]`。
fn export_golden(
    game_events: &[beergame_domain::GameEvent],
    session_events: &[beergame_domain::SessionEvent],
) -> R<()> {
    let Some(path) = std::env::var_os("GOLDEN_EXPORT") else {
        return Ok(());
    };
    let mut entries = Vec::new();
    for event in game_events {
        let (event_type, schema_version, payload) = GameCodec.encode(event)?;
        entries.push(serde_json::json!({
            "stream": "GAME", "event_type": event_type, "schema_version": schema_version, "payload": payload
        }));
    }
    for event in session_events {
        let (event_type, schema_version, payload) = SessionCodec.encode(event)?;
        entries.push(serde_json::json!({
            "stream": "SESSION", "event_type": event_type, "schema_version": schema_version, "payload": payload
        }));
    }
    let text = serde_json::to_string_pretty(&entries).map_err(e)?;
    std::fs::write(path, text).map_err(e)
}

#[test]
fn nf_r15__現行より新しいスキーマの版は_読めないとして拒み_不正な版も拒む() {
    let payload = serde_json::json!({"gameId": "00000000-0000-0000-0000-000000000001"});
    // 版の検査が先（ペイロードの正しさに関わらず、版の理由で拒む）
    let newer = GameCodec.decode("GameStarted", 2, payload.clone());
    assert!(newer.is_err_and(|m| m.contains("新しい")));
    let newer = SessionCodec.decode("SessionEnded", 2, serde_json::json!({}));
    assert!(newer.is_err_and(|m| m.contains("新しい")));
    assert!(GameCodec.decode("GameStarted", 0, payload).is_err());
    // 現行の版は読める
    assert!(
        GameCodec
            .decode(
                "GameStarted",
                1,
                serde_json::json!({"gameId": "00000000-0000-0000-0000-000000000001"})
            )
            .is_ok()
    );
}

#[test]
fn ac2_3_4__不明なイベントと不正な値は変換に失敗する() {
    assert!(
        GameCodec
            .decode("Unknown", 1, serde_json::json!({}))
            .is_err()
    );
    assert!(
        SessionCodec
            .decode("Unknown", 1, serde_json::json!({}))
            .is_err()
    );
    assert!(
        GameCodec
            .decode(
                "RoleAssigned",
                1,
                serde_json::json!({"participantId": "x", "role": "RETAILER"})
            )
            .is_err()
    );
    assert!(
        SessionCodec
            .decode("SessionEnded", 1, serde_json::json!({"reason": "OTHER"}))
            .is_err()
    );
    assert!(
        GameCodec
            .decode("RoleAssigned", 1, serde_json::json!({"role": "RETAILER"}))
            .is_err()
    );
}

#[test]
fn d7__イベントに表示名を含めない() -> R<()> {
    let (_, _, payload) = GameCodec.encode(&beergame_domain::GameEvent::ParticipantJoined {
        participant_id: ParticipantId::new(1),
        credential_expires_at: Instant::from_epoch_millis(1),
    })?;
    if payload.to_string().contains("displayName") {
        Err("表示名がイベントに入った".to_owned())
    } else {
        Ok(())
    }
}

#[test]
fn ac3_1_2__停止_再開_代理入力のイベントは_JSON_に変換して戻すと同じになり_操作者が残る() -> R<()> {
    use beergame_domain::SessionEvent;
    let proxied = SessionEvent::ProxyDecisionSubmitted {
        week: Week::of(1).map_err(e)?,
        role: Role::Factory,
        quantity: Quantity::of(6).map_err(e)?,
        decision_version: DecisionVersion::new(1),
        operator: GAME,
        submitted_role_count: 1,
    };
    for event in [
        SessionEvent::SessionPaused,
        SessionEvent::SessionResumed,
        proxied.clone(),
    ] {
        roundtrip(&SessionCodec, &event)?;
    }
    // 監査: 代理入力の操作者は進行役（ゲームの ID）
    assert_eq!(
        SessionCodec.actor(&proxied),
        ("FACILITATOR", Some(uuid::Uuid::from_u128(GAME.get())))
    );
    assert_eq!(
        SessionCodec.actor(&SessionEvent::SessionPaused),
        ("ANONYMOUS", None)
    );
    let by_participant = SessionEvent::DecisionSaved {
        week: Week::of(1).map_err(e)?,
        role: Role::Retailer,
        quantity: Quantity::of(4).map_err(e)?,
        decision_version: DecisionVersion::new(1),
        editor: beergame_domain::Editor::ByParticipant(ParticipantId::new(4)),
        submitted_role_count: 1,
    };
    assert_eq!(
        SessionCodec.actor(&by_participant),
        ("PARTICIPANT", Some(uuid::Uuid::from_u128(4)))
    );
    Ok(())
}

#[test]
fn ac3_2_5__資格の失効と再発行のイベントは_JSON_に変換して戻すと同じになる() -> R<()> {
    use beergame_domain::GameEvent;
    for event in [
        GameEvent::CredentialRevoked {
            participant_id: ParticipantId::new(4),
        },
        GameEvent::CredentialReissued {
            participant_id: ParticipantId::new(4),
            credential_expires_at: Instant::from_epoch_millis(1_000),
        },
    ] {
        roundtrip(&GameCodec, &event)?;
    }
    Ok(())
}

#[test]
fn ac3_2_5__役割の入れ替えのイベントは_JSON_に変換して戻すと同じになる() -> R<()> {
    use beergame_domain::{GameEvent, SessionEvent};
    roundtrip(
        &GameCodec,
        &GameEvent::ParticipantReplaced {
            participant_id: ParticipantId::new(5),
            role: Role::Retailer,
            replaced: vec![ParticipantId::new(3), ParticipantId::new(4)],
        },
    )?;
    roundtrip(
        &SessionCodec,
        &SessionEvent::RoleReplaced {
            role: Role::Retailer,
            new_holder: ParticipantId::new(5),
        },
    )?;
    // 旧担当者の一覧が配列でない・UUID でない値は変換に失敗する
    assert!(
        GameCodec
            .decode(
                "ParticipantReplaced",
                1,
                serde_json::json!({"participantId": "00000000-0000-0000-0000-000000000005", "role": "RETAILER", "replaced": "x"})
            )
            .is_err()
    );
    assert!(
        GameCodec
            .decode(
                "ParticipantReplaced",
                1,
                serde_json::json!({"participantId": "00000000-0000-0000-0000-000000000005", "role": "RETAILER", "replaced": [1]})
            )
            .is_err()
    );
    Ok(())
}

#[test]
fn ac1_1_3__カスタム条件つきの_GameCreated_は往復でき_条件の無い従来のイベントはキットとして読める()
-> R<()> {
    use beergame_domain::{ConditionsInput, GameEvent};
    let mut input = ConditionsInput::default();
    input.initial_inventory.insert(Role::Retailer, 20);
    input.shipment_delay_weeks = Some(3);
    input.holding_cost_minor = Some(80);
    input.disclosure_policy = Some("NONE".to_owned());
    let settings = GameSettings::custom(3, &[4, 4, 4], CommitMode::Auto, &input).map_err(e)?;
    let created = GameEvent::GameCreated {
        game_id: GAME,
        join_code: JoinCode::of("abcd1234").map_err(e)?,
        settings: settings.clone(),
        retention_days: RetentionDays::of(30).map_err(e)?,
        facilitator_credential_expires_at: Instant::from_epoch_millis(1_000),
    };
    roundtrip(&GameCodec, &created)?;
    // conditions の無いイベント（B7 まで）は、キットの値として読む
    let (name, schema, mut payload) = GameCodec.encode(&created)?;
    if let Some(settings_json) = payload
        .get_mut("settings")
        .and_then(serde_json::Value::as_object_mut)
    {
        settings_json.remove("conditions");
        settings_json.insert("holdingCost".to_owned(), serde_json::json!(50));
    }
    let legacy = GameCodec.decode(&name, schema, payload)?;
    let GameEvent::GameCreated { settings: read, .. } = legacy else {
        return Err("GameCreated ではない".to_owned());
    };
    assert_eq!(read.conditions, beergame_domain::Conditions::kit());
    Ok(())
}

#[test]
fn ac2_4_5__確定方式の変更は_JSON_に変換して戻すと同じになり_不明な確定の種類は失敗する() -> R<()> {
    use beergame_domain::SessionEvent;
    roundtrip(
        &SessionCodec,
        &SessionEvent::CommitModeChanged {
            mode: CommitMode::Auto,
        },
    )?;
    assert!(
        SessionCodec
            .decode(
                "WeekCommitted",
                1,
                serde_json::json!({"week": 1, "commitKind": "OTHER"})
            )
            .is_err()
    );
    Ok(())
}

#[test]
fn ac1_3_1__観察用の招待と観察者の参加のイベントは_JSON_に変換して戻すと同じになる() -> R<()> {
    use beergame_domain::{GameEvent, InvitationId, ObserverId};
    for event in [
        GameEvent::ObserverInvited {
            invitation_id: InvitationId::new(1),
            expires_at: Instant::from_epoch_millis(1_000),
        },
        GameEvent::ObserverInvitationRevoked {
            invitation_id: InvitationId::new(1),
        },
        GameEvent::ObserverJoined {
            observer_id: ObserverId::new(2),
            invitation_id: InvitationId::new(1),
        },
    ] {
        roundtrip(&GameCodec, &event)?;
    }
    Ok(())
}
