//! 共有する `features/`（Kotlin 版と同じ日本語 Gherkin）を、Rust のバックエンド（HTTP。実 PostgreSQL 18.6）に対して実行する。
//! 許可リスト（`allowlist.txt`）のシナリオだけを実行する。定義のないステップ（Undefined）は失敗にする（`fail_on_skipped`）。

mod steps;
mod world;

use std::io::Write;
use std::path::Path;

use beergame_acceptance::{Allowlist, api_scenarios};
use cucumber::{World, WriterExt, writer};

use crate::world::ApiWorld;

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
        ApiWorld::cucumber()
            .with_writer(
                writer::Basic::stdout()
                    .summarized()
                    .tee::<ApiWorld, _>(writer::JUnit::for_tee(file, 0))
                    .normalized(),
            )
            .fail_on_skipped()
            .max_concurrent_scenarios(1)
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
    ApiWorld::cucumber()
        .fail_on_skipped()
        .max_concurrent_scenarios(1)
        .filter_run_and_exit(dir, move |feature, _, scenario| {
            let path = feature
                .path
                .as_ref()
                .map_or(String::new(), |p| p.display().to_string());
            has_tag(&scenario.tags, "api") && allowed.allows(&path, &scenario.name)
        })
        .await;
}
