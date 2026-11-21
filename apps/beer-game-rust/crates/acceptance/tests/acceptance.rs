//! 共有する `features/`（Kotlin 版と同じ日本語 Gherkin）を、Rust のドメインに対して実行する。
//! B1 の検証: 日本語 Gherkin の実行、未定義のステップの扱い（`fail_on_skipped`）、JSON 出力。

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

use beergame_acceptance::{Allowlist, api_scenarios};
use beergame_domain::{
    Actor, CommitMode, DisplayName, GameCommand, GameError, GameSettings, GameState, Instant,
    JoinCode, ParticipantId, RetentionDays, Role, SessionState, StartDecision, StartError,
    StartGame, decide_game, evolve_game, evolve_session, start_game,
};
use cucumber::{World, WriterExt, given, then, when, writer};

const GAME: beergame_domain::GameId = beergame_domain::GameId::new(1);

#[derive(Debug, World)]
#[world(init = Self::new)]
struct GameWorld {
    game: GameState,
    session: SessionState,
    names: BTreeMap<String, ParticipantId>,
    started: Option<Result<StartDecision, StartError>>,
}

impl GameWorld {
    fn new() -> Self {
        GameWorld {
            game: GameState::NotCreated,
            session: SessionState::NotStarted,
            names: BTreeMap::new(),
            started: None,
        }
    }

    fn at() -> Instant {
        Instant::from_epoch_millis(1_000)
    }

    fn apply(&mut self, command: &GameCommand) -> Result<(), String> {
        let events = decide_game(&self.game, command).map_err(|e| format!("{e:?}"))?;
        for event in &events {
            let next = evolve_game(self.game.clone(), event);
            if next.is_ignored() {
                return Err(format!("decide が作らない列: {event:?}"));
            }
            self.game = next.into_state();
        }
        Ok(())
    }

    fn participant(&mut self, name: &str) -> ParticipantId {
        let next = u128::try_from(self.names.len())
            .unwrap_or(0)
            .saturating_add(1);
        *self
            .names
            .entry(name.to_owned())
            .or_insert(ParticipantId::new(next))
    }

    fn join(&mut self, name: &str) -> Result<ParticipantId, String> {
        let id = self.participant(name);
        self.apply(&GameCommand::JoinGame {
            actor: Actor::Anonymous,
            at: Self::at(),
            participant_id: id,
            display_name: DisplayName::of(name).map_err(|e| format!("{e:?}"))?,
            credential_expires_at: Instant::from_epoch_millis(9_000_000),
        })?;
        Ok(id)
    }

    fn assign(&mut self, name: &str, role: Role) -> Result<(), String> {
        let id = self.participant(name);
        self.apply(&GameCommand::AssignRole {
            actor: Actor::Facilitator(GAME),
            at: Self::at(),
            participant_id: id,
            role,
        })
    }

    fn holders(&self, role: Role) -> Vec<ParticipantId> {
        self.game
            .data()
            .map(|d| d.role_assignments().get(role).iter().copied().collect())
            .unwrap_or_default()
    }
}

fn role_of(name: &str) -> Result<Role, String> {
    match name {
        "小売店" => Ok(Role::Retailer),
        "二次卸" => Ok(Role::Wholesaler),
        "一次卸" => Ok(Role::Distributor),
        "工場" => Ok(Role::Factory),
        other => Err(format!("未知の役割: {other}")),
    }
}

#[given("進行役が、キット準拠のゲームを作成している")]
fn game_created(world: &mut GameWorld) -> Result<(), String> {
    let settings =
        GameSettings::kit(4, &[4, 4, 4, 4], CommitMode::Manual).map_err(|e| format!("{e:?}"))?;
    world.apply(&GameCommand::CreateGame {
        actor: Actor::Anonymous,
        at: GameWorld::at(),
        game_id: GAME,
        join_code: JoinCode::of("abcd1234").map_err(|e| format!("{e:?}"))?,
        settings,
        retention_days: RetentionDays::of(30).map_err(|e| format!("{e:?}"))?,
        facilitator_credential_expires_at: Instant::from_epoch_millis(9_000_000),
    })
}

#[given(regex = r"^参加者「(.+)」が(.+)に割り当てられている$")]
fn participant_assigned(world: &mut GameWorld, name: String, role: String) -> Result<(), String> {
    world.join(&name)?;
    world.assign(&name, role_of(&role)?)
}

#[given(regex = r"^参加者「(.+)」が、役割なしで参加している$")]
fn participant_without_role(world: &mut GameWorld, name: String) -> Result<(), String> {
    world.join(&name).map(|_| ())
}

#[given(regex = r"^\d+ 人の参加者が、(.+)にそれぞれ割り当てられている$")]
fn participants_assigned(world: &mut GameWorld, roles: String) -> Result<(), String> {
    for (i, role) in roles.split('、').enumerate() {
        let name = format!("参加者{}", i + 1);
        world.join(&name)?;
        world.assign(&name, role_of(role)?)?;
    }
    Ok(())
}

#[when(regex = r"^進行役が、(.+)を(.+)に割り当てる$")]
fn facilitator_assigns(world: &mut GameWorld, name: String, role: String) -> Result<(), String> {
    world.assign(&name, role_of(&role)?)
}

#[when(regex = r"^進行役がゲームを開始(する|しようとする)$")]
fn facilitator_starts(world: &mut GameWorld, _kind: String) {
    let result = start_game(
        &world.game,
        &world.session,
        &StartGame {
            actor: Actor::Facilitator(GAME),
            at: GameWorld::at(),
        },
    );
    if let Ok(decision) = &result {
        for event in &decision.game {
            world.game = evolve_game(world.game.clone(), event).into_state();
        }
        for event in &decision.session {
            world.session = evolve_session(world.session.clone(), event).into_state();
        }
    }
    world.started = Some(result);
}

#[then(regex = r"^(.+)は(.+)に割り当てられている$")]
fn is_assigned(world: &mut GameWorld, name: String, role: String) -> Result<(), String> {
    let id = *world.names.get(&name).ok_or("未知の参加者")?;
    if world.holders(role_of(&role)?).contains(&id) {
        Ok(())
    } else {
        Err(format!("{name} は {role} に割り当てられていない"))
    }
}

#[then(regex = r"^(.+)は(.+)には割り当てられていない$")]
fn is_not_assigned(world: &mut GameWorld, name: String, role: String) -> Result<(), String> {
    let id = *world.names.get(&name).ok_or("未知の参加者")?;
    if world.holders(role_of(&role)?).contains(&id) {
        Err(format!("{name} は {role} に割り当てられている"))
    } else {
        Ok(())
    }
}

#[then(regex = r"^(.+)に (\d+) 人の参加者が割り当てられている$")]
fn holder_count(world: &mut GameWorld, role: String, count: usize) -> Result<(), String> {
    let actual = world.holders(role_of(&role)?).len();
    if actual == count {
        Ok(())
    } else {
        Err(format!("{role} の担当者は {actual} 人（期待 {count}）"))
    }
}

#[then("ゲームは開始されている")]
fn game_started(world: &mut GameWorld) -> Result<(), String> {
    match (&world.started, &world.game) {
        (Some(Ok(_)), GameState::Started(_)) => Ok(()),
        (started, game) => Err(format!("開始されていない: {started:?} / {game:?}")),
    }
}

#[then("ゲームは開始されない")]
fn game_not_started(world: &mut GameWorld) -> Result<(), String> {
    match &world.started {
        Some(Err(_)) => Ok(()),
        started => Err(format!("開始された: {started:?}")),
    }
}

#[then(regex = r"^不足している役割として(.+)が示される$")]
fn missing_roles(world: &mut GameWorld, role: String) -> Result<(), String> {
    match &world.started {
        Some(Err(StartError::Game(GameError::StartConditionNotMet(missing)))) => {
            if missing == &vec![role_of(&role)?] {
                Ok(())
            } else {
                Err(format!("不足の役割が違う: {missing:?}"))
            }
        }
        other => Err(format!("開始条件の誤りではない: {other:?}")),
    }
}

/// 共有する features/ の場所（Kotlin 版。読み取り専用）。
fn features_dir() -> std::path::PathBuf {
    // 調査用に、環境変数 `BEERGAME_FEATURES` で場所を替えられる（既定は Kotlin 版の features/）。
    std::env::var_os("BEERGAME_FEATURES").map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../beer-game-kotlin/features"),
        std::path::PathBuf::from,
    )
}

fn has_tag(tags: &[String], tag: &str) -> bool {
    tags.iter().any(|t| t == tag)
}

/// 許可したファイルだけを、読み取り専用の参照（シンボリックリンク）として並べた場所。
/// Rust の gherkin は `ルール:` を解析できず、ディレクトリ全体を渡すと実行が止まるため、許可したファイルだけを渡す。
fn allowed_features_dir(allowlist: &Allowlist) -> std::io::Result<std::path::PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/acceptance-features");
    let _removed = std::fs::remove_dir_all(&root);
    for file in allowlist.files() {
        let target = root.join(file);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::os::unix::fs::symlink(std::fs::canonicalize(features_dir().join(file))?, target)?;
    }
    Ok(root)
}

/// 許可の外の `@api` シナリオを「未対応」として数えて表示する（進捗の指標。許可リストの外が通る割合の分母）。
fn report_unsupported(allowlist: &Allowlist) {
    let mut total = 0;
    let mut supported = 0;
    let mut stack = vec![features_dir()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for path in entries.filter_map(Result::ok).map(|e| e.path()) {
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "feature")
                && let Ok(text) = std::fs::read_to_string(&path)
            {
                let name = path.display().to_string();
                for scenario in api_scenarios(&text) {
                    total += 1;
                    if allowlist.allows(&name, &scenario) {
                        supported += 1;
                    }
                }
            }
        }
    }
    drop(writeln!(
        std::io::stdout(),
        "[許可リスト] @api のシナリオ {total} 件のうち、Rust で実行するのは {supported} 件（未対応 {} 件）",
        total - supported
    ));
}

#[tokio::main]
async fn main() {
    let allowlist = Allowlist::parse(
        &std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("allowlist.txt"))
            .unwrap_or_default(),
    );
    report_unsupported(&allowlist);
    let Ok(dir) = allowed_features_dir(&allowlist) else {
        drop(writeln!(
            std::io::stderr(),
            "許可したファイルを並べられない（共有する features/ に無いファイルが許可リストにある）"
        ));
        std::process::exit(1);
    };
    let allowed = allowlist.clone();
    // 結果を JUnit XML に出す（CI の成果物・ID と AC の対応表の入力。B3 で使う）。
    if let Some(path) = std::env::var_os("CUCUMBER_JUNIT")
        && let Ok(file) = std::fs::File::create(path)
    {
        GameWorld::cucumber()
            .with_writer(
                writer::Basic::stdout()
                    .summarized()
                    .tee::<GameWorld, _>(writer::JUnit::for_tee(file, 0))
                    .normalized(),
            )
            .fail_on_skipped()
            .filter_run_and_exit(dir, move |feature, _, scenario| {
                let path = feature
                    .path
                    .as_ref()
                    .map_or(String::new(), |p| p.display().to_string());
                has_tag(&scenario.tags, "api") && allowed.allows(&path, &scenario.name)
            })
            .await;
        return;
    }
    // 定義のないステップ（Undefined）は、既定では skipped で終了コード 0 になるため、失敗にする。
    GameWorld::cucumber()
        .fail_on_skipped()
        .filter_run_and_exit(dir, move |feature, _, scenario| {
            let path = feature
                .path
                .as_ref()
                .map_or(String::new(), |p| p.display().to_string());
            has_tag(&scenario.tags, "api") && allowed.allows(&path, &scenario.name)
        })
        .await;
}
