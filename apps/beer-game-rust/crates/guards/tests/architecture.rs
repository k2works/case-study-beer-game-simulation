//! DS-4: クレートの依存方向。domain は、非同期ランタイム・DB・HTTP・乱数・ログに依存しない。
//! 検査の本体（`forbidden_dependencies`）は純粋関数で、禁止の検出は lib のテストで確かめている。

use beergame_guards::{DOMAIN_FORBIDDEN, forbidden_dependencies};
use std::process::Command;

#[test]
fn ds4_domain_は禁止されたクレートに依存しない() -> Result<(), String> {
    let out = Command::new("cargo")
        .args([
            "tree",
            "--package",
            "beergame-domain",
            "--edges",
            "normal",
            "--prefix",
            "none",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    let tree = String::from_utf8_lossy(&out.stdout);
    let found = forbidden_dependencies(&tree, DOMAIN_FORBIDDEN);
    if found.is_empty() {
        Ok(())
    } else {
        Err(format!("domain が禁止された依存を持つ: {found:?}\n{tree}"))
    }
}
