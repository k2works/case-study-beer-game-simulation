// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! ユースケース（メモリのポートで）。入力の検証、秘密の扱い、周辺ストアへの書き込みの導出。

use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use beergame_application::{
    AppFailure, AppSettings, CreateGameInput, CredentialKind, DomainError, Env, EventStore,
    PeripheralWrite, Secret, StreamRead, create_game, join_game,
};
use beergame_domain::{GameError, GameEvent, GameId, Instant, ValidationError};

struct FixedEnv(AtomicU32);

impl Env for FixedEnv {
    fn now(&self) -> Instant {
        Instant::from_epoch_millis(1_000)
    }
    fn new_id(&self) -> u128 {
        u128::from(self.0.fetch_add(1, Ordering::SeqCst)) + 100
    }
    fn token_bytes(&self) -> [u8; 32] {
        [u8::try_from(self.0.fetch_add(1, Ordering::SeqCst) % 250).unwrap_or(0); 32]
    }
    fn join_code(&self) -> String {
        "abcd1234".to_owned()
    }
}

fn settings() -> AppSettings {
    AppSettings {
        credential_key: Secret::new(vec![7; 32]),
        key_version: 1,
        credential_ttl_millis: 86_400_000,
        retention_days: 30,
        max_attempts: 3,
    }
}

#[derive(Default)]
struct Memory {
    events: Mutex<Vec<GameEvent>>,
    writes: Mutex<Vec<PeripheralWrite>>,
}

impl EventStore<GameEvent> for Memory {
    type Tx = (Vec<GameEvent>, Vec<PeripheralWrite>);

    async fn begin(&self) -> Result<Self::Tx, AppFailure> {
        Ok((Vec::new(), Vec::new()))
    }

    async fn read(&self, _tx: &mut Self::Tx) -> Result<StreamRead<GameEvent>, AppFailure> {
        let events = self
            .events
            .lock()
            .map_err(|_| AppFailure::RetryExhausted)?
            .clone();
        Ok(StreamRead {
            version: u64::try_from(events.len()).unwrap_or(0),
            events,
        })
    }

    async fn append(
        &self,
        tx: &mut Self::Tx,
        expected: u64,
        events: Vec<GameEvent>,
    ) -> Result<u64, AppFailure> {
        tx.0.extend(events);
        Ok(expected + u64::try_from(tx.0.len()).unwrap_or(0))
    }

    async fn write_peripheral(
        &self,
        tx: &mut Self::Tx,
        writes: &[PeripheralWrite],
    ) -> Result<(), AppFailure> {
        tx.1.extend_from_slice(writes);
        Ok(())
    }

    async fn commit(&self, tx: Self::Tx) -> Result<(), AppFailure> {
        self.events
            .lock()
            .map_err(|_| AppFailure::RetryExhausted)?
            .extend(tx.0);
        self.writes
            .lock()
            .map_err(|_| AppFailure::RetryExhausted)?
            .extend(tx.1);
        Ok(())
    }

    async fn rollback(&self, _tx: Self::Tx) -> Result<(), AppFailure> {
        Ok(())
    }
}

#[tokio::test]
async fn ac1_1_2__無効な需要系列は作成せず_対象の週ごとの誤りをすべて返す() {
    let store = Memory::default();
    let input = CreateGameInput {
        final_week: 12,
        demand: vec![4, 4, 4, 4, 1001, 4, 4, 4, 4, 4, 4, 4],
    };
    let result = create_game(&store, &FixedEnv(AtomicU32::new(0)), &settings(), &input).await;
    assert!(matches!(
        result.as_ref().err(),
        Some(AppFailure::Invalid(errors)) if errors == &vec![ValidationError::DemandSeriesInvalid { week_index: 5, reason: "需要は 0〜1000 の整数" }]
    ));
    assert!(
        store.events.lock().map(|e| e.is_empty()).unwrap_or(false),
        "作成されない"
    );
}

#[tokio::test]
async fn ac1_1_1__作成は進行役の資格を一度だけ返し_保存はダイジェストだけ() -> Result<(), String> {
    let store = Memory::default();
    let input = CreateGameInput {
        final_week: 3,
        demand: vec![4, 4, 4],
    };
    let outcome = create_game(&store, &FixedEnv(AtomicU32::new(0)), &settings(), &input)
        .await
        .map_err(|e| format!("{e:?}"))?;
    assert_eq!(outcome.join_code, "abcd1234");
    let writes = store.writes.lock().map_err(|e| e.to_string())?.clone();
    let [
        PeripheralWrite::Credential {
            digest,
            kind,
            subject_id,
            ..
        },
    ] = writes.as_slice()
    else {
        return Err(format!("資格の書き込みが 1 件ではない: {writes:?}"));
    };
    assert_eq!(*kind, CredentialKind::Facilitator);
    assert_eq!(*subject_id, outcome.game_id.get());
    assert_eq!(digest.len(), 64);
    assert!(
        !digest.contains(outcome.facilitator_credential.expose().as_str()),
        "生の値を保存しない"
    );
    assert!(
        !format!("{outcome:?}").contains(outcome.facilitator_credential.expose().as_str()),
        "Debug に出ない"
    );
    Ok(())
}

#[tokio::test]
async fn ac1_2_1__参加は表示名を周辺ストアにだけ書き_イベントには入れない() -> Result<(), String> {
    let store = Memory::default();
    let env = FixedEnv(AtomicU32::new(0));
    let created = create_game(
        &store,
        &env,
        &settings(),
        &CreateGameInput {
            final_week: 3,
            demand: vec![4, 4, 4],
        },
    )
    .await
    .map_err(|e| format!("{e:?}"))?;
    let joined = join_game(&store, &env, &settings(), created.game_id, "  山本  ")
        .await
        .map_err(|e| format!("{e:?}"))?;
    let writes = store.writes.lock().map_err(|e| e.to_string())?.clone();
    assert!(writes.iter().any(|w| matches!(w, PeripheralWrite::DisplayName { name, participant_id, .. } if name == "山本" && *participant_id == joined.participant_id)));
    assert!(writes.iter().any(|w| matches!(
        w,
        PeripheralWrite::Credential {
            kind: CredentialKind::Participant,
            ..
        }
    )));
    let events = store.events.lock().map_err(|e| e.to_string())?.clone();
    assert!(
        !format!("{events:?}").contains("山本"),
        "表示名はイベントに入らない"
    );
    Ok(())
}

#[tokio::test]
async fn ac1_2_1__表示名が空なら参加せず_入力の誤りを返す() -> Result<(), String> {
    let store = Memory::default();
    let result = join_game(
        &store,
        &FixedEnv(AtomicU32::new(0)),
        &settings(),
        GameId::new(1),
        "   ",
    )
    .await;
    assert!(matches!(result.err(), Some(AppFailure::Invalid(_))));
    Ok(())
}

#[tokio::test]
async fn ac1_2_2__作成されていないゲームへの参加は_NotPreparing() -> Result<(), String> {
    let store = Memory::default();
    let result = join_game(
        &store,
        &FixedEnv(AtomicU32::new(0)),
        &settings(),
        GameId::new(1),
        "山本",
    )
    .await;
    assert!(matches!(
        result.err(),
        Some(AppFailure::Domain(DomainError::Game(
            GameError::NotPreparing
        )))
    ));
    Ok(())
}

#[tokio::test]
async fn nf_s__資格の鍵が空なら作成できない() {
    let store = Memory::default();
    let mut s = settings();
    s.credential_key = Secret::new(Vec::new());
    let result = create_game(
        &store,
        &FixedEnv(AtomicU32::new(0)),
        &s,
        &CreateGameInput {
            final_week: 3,
            demand: vec![4, 4, 4],
        },
    )
    .await;
    assert!(matches!(result.err(), Some(AppFailure::Persistence(_))));
}
