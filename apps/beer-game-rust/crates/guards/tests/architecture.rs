//! DS-4: クレートの依存方向。domain は、非同期ランタイム・DB・HTTP・乱数・ログに依存しない。
//! 検査の本体（`forbidden_dependencies`）は純粋関数で、禁止の検出は lib のテストで確かめている。

use beergame_guards::{APPLICATION_FORBIDDEN, DOMAIN_FORBIDDEN, forbidden_dependencies};
use std::process::Command;

fn normal_tree(package: &str) -> Result<String, String> {
    let out = Command::new("cargo")
        .args([
            "tree",
            "--package",
            package,
            "--edges",
            "normal",
            "--prefix",
            "none",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

fn assert_clean(package: &str, forbidden: &[&str]) -> Result<(), String> {
    let tree = normal_tree(package)?;
    let found = forbidden_dependencies(&tree, forbidden);
    if found.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{package} が禁止された依存を持つ: {found:?}\n{tree}"
        ))
    }
}

#[test]
fn ds4_domain_は禁止されたクレートに依存しない() -> Result<(), String> {
    assert_clean("beergame-domain", DOMAIN_FORBIDDEN)
}

#[test]
fn ds4_application_は_db_と_http_とアダプターに依存しない() -> Result<(), String> {
    assert_clean("beergame-application", APPLICATION_FORBIDDEN)
}
