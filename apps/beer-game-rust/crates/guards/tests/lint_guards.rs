//! 守りの検査（DS-1〜3。開発戦略の「戦略の適用をテストと hook でガードする」）。
//!
//! 規則を破る最小のコード（`tests/fixtures/*.rs`）を、ワークスペースと同じ lint・domain と同じ
//! `clippy.toml` を持つ一時のクレートに置いて `cargo clippy` を実行し、**期待の lint で失敗する**ことを確かめる。
//! 規則を破らないコード（`tests/fixtures/clean/`）は通ることも確かめる（偽陽性を出さない）。
//! 出発点は docs/reference/関数型プログラミングガイド_Rust編.md の 9.6。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// ワークスペースの `[workspace.lints.*]` を、クレートの `[lints.*]` に読み替えた Cargo.toml を作る。
fn crate_manifest() -> Result<String, String> {
    let root =
        fs::read_to_string(workspace_root().join("Cargo.toml")).map_err(|e| e.to_string())?;
    let start = root
        .find("[workspace.lints.rust]")
        .ok_or("[workspace.lints.rust] が無い")?;
    let lints = root[start..].replace("[workspace.lints.", "[lints.");
    Ok(format!(
        "[package]\nname = \"fixture\"\nversion = \"0.0.0\"\nedition = \"2024\"\n\n[workspace]\n\n{lints}"
    ))
}

/// 後始末。失敗しても検査の結果に影響しないため、結果は捨てる。
#[allow(clippy::let_underscore_must_use)] // 理由: 一時ディレクトリの削除の失敗は、検査の合否と無関係
fn remove(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

struct Outcome {
    success: bool,
    stderr: String,
}

/// fixture を一時のクレートに置いて clippy を実行する。
fn clippy(fixture: &str) -> Result<Outcome, String> {
    let name = fixture.replace('/', "_");
    let dir = std::env::temp_dir().join(format!("beergame-guards-{}-{name}", std::process::id()));
    remove(&dir);
    fs::create_dir_all(dir.join("src")).map_err(|e| e.to_string())?;
    fs::write(dir.join("Cargo.toml"), crate_manifest()?).map_err(|e| e.to_string())?;
    fs::copy(
        workspace_root().join("crates/domain/clippy.toml"),
        dir.join("clippy.toml"),
    )
    .map_err(|e| e.to_string())?;
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/{fixture}.rs")),
        dir.join("src/lib.rs"),
    )
    .map_err(|e| e.to_string())?;
    // 並列に実行するテストが互いの成果物を共有しないよう、fixture ごとに別のディレクトリを使う。
    let target = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/guards")
        .join(&name);
    let out = Command::new("cargo")
        .args(["clippy", "--quiet", "--", "-D", "warnings"])
        .current_dir(&dir)
        .env("CARGO_TARGET_DIR", target)
        .output()
        .map_err(|e| e.to_string())?;
    remove(&dir);
    Ok(Outcome {
        success: out.status.success(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// 規則を破る fixture は、失敗し、期待の lint の名前を報告する。
/// 報告の表記は `unsafe-code` と `unsafe_code` が混在するため、`-` を `_` にそろえて照合する。
fn assert_rejected(fixture: &str, lint: &str) -> Result<(), String> {
    let outcome = clippy(fixture)?;
    if outcome.success {
        return Err(format!(
            "{fixture}: 規則を破っているのに通った\n{}",
            outcome.stderr
        ));
    }
    if !outcome.stderr.replace('-', "_").contains(lint) {
        return Err(format!(
            "{fixture}: 期待の lint `{lint}` が報告されていない\n{}",
            outcome.stderr
        ));
    }
    Ok(())
}

/// 規則を破らない（または lint で守れない）fixture は、通る。
fn assert_accepted(fixture: &str) -> Result<(), String> {
    let outcome = clippy(fixture)?;
    if !outcome.success {
        return Err(format!(
            "{fixture}: 規則を破っていないのに失敗した\n{}",
            outcome.stderr
        ));
    }
    Ok(())
}

#[test]
fn ds1_unsafe_を使うと失敗する() -> Result<(), String> {
    assert_rejected("unsafe_code", "unsafe_code")?;
    Ok(())
}

#[test]
fn ds2_unwrap_を使うと失敗する() -> Result<(), String> {
    assert_rejected("unwrap_used", "unwrap_used")?;
    Ok(())
}

#[test]
fn ds2_expect_を使うと失敗する() -> Result<(), String> {
    assert_rejected("expect_used", "expect_used")?;
    Ok(())
}

#[test]
fn ds2_panic_を使うと失敗する() -> Result<(), String> {
    assert_rejected("panic", "panic")?;
    Ok(())
}

#[test]
fn ds2_todo_を使うと失敗する() -> Result<(), String> {
    assert_rejected("todo", "todo")?;
    Ok(())
}

#[test]
fn ds2_添字アクセスを使うと失敗する() -> Result<(), String> {
    assert_rejected("indexing_slicing", "indexing_slicing")?;
    Ok(())
}

#[test]
fn ds2_単体の_enum_のワイルドカードを使うと失敗する() -> Result<(), String> {
    assert_rejected("wildcard_enum_match_arm", "wildcard_enum_match_arm")?;
    Ok(())
}

#[test]
fn ds2_単一の腕を隠すワイルドカードを使うと失敗する() -> Result<(), String> {
    assert_rejected(
        "match_wildcard_for_single_variants",
        "match_wildcard_for_single_variants",
    )?;
    Ok(())
}

#[test]
fn ds2_標準出力を使うと失敗する() -> Result<(), String> {
    assert_rejected("print_stdout", "print_stdout")?;
    Ok(())
}

#[test]
fn ds2_dbg_を使うと失敗する() -> Result<(), String> {
    assert_rejected("dbg_macro", "dbg_macro")?;
    Ok(())
}

#[test]
fn ds2_失敗を捨てると失敗する() -> Result<(), String> {
    assert_rejected("let_underscore_must_use", "let_underscore_must_use")?;
    assert_rejected("unused_must_use", "unused_must_use")?;
    Ok(())
}

#[test]
fn ds3_時計を直接呼ぶと失敗する() -> Result<(), String> {
    assert_rejected("disallowed_methods", "disallowed_methods")?;
    Ok(())
}

#[test]
fn ds3_共有状態の_mutex_を使うと失敗する() -> Result<(), String> {
    assert_rejected("disallowed_types", "disallowed_types")?;
    Ok(())
}

#[test]
fn 規則を破らないコードは通る() -> Result<(), String> {
    assert_accepted("clean/ok")?;
    Ok(())
}

/// ガイド 9.4: 組（タプル）の `match` のワイルドカードは、lint で守られない。
/// この限界を記録する（通ることを確かめる）。守りはテスト（`evolve` の腕を消すと落ちる性質テスト。DS-5）で補う。
/// もし将来 lint が発火するようになれば、このテストが落ちるので、守りの対応表を見直す。
#[test]
fn ガイド9_4_組の_match_のワイルドカードは_lint_で守られない() -> Result<(), String> {
    assert_accepted("clean/tuple_wildcard_not_detected")?;
    Ok(())
}
