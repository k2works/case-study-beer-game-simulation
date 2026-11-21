//! DS-10: テスト名に AC（または分類）の接頭辞を付ける（RT1）。付けていないテストがあれば失敗にする。

use std::fs;
use std::path::{Path, PathBuf};

use beergame_guards::{has_valid_test_prefix, test_names};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            // fixture（規則を破るコード）は、テストではない
            if path
                .file_name()
                .is_some_and(|n| n == "fixtures" || n == "target")
            {
                continue;
            }
            rust_files(&path, out)?;
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    Ok(())
}

#[test]
fn ds10_すべてのテストの名前が接頭辞の規則を満たす() -> Result<(), String> {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = Vec::new();
    rust_files(&crates, &mut files).map_err(|e| e.to_string())?;
    let mut violations = Vec::new();
    let mut total = 0;
    for file in files {
        let source = fs::read_to_string(&file).map_err(|e| e.to_string())?;
        for name in test_names(&source) {
            total += 1;
            if !has_valid_test_prefix(&name) {
                violations.push(format!("{}: {name}", file.display()));
            }
        }
    }
    if total < 100 {
        return Err(format!("テストを拾えていない（{total} 件）"));
    }
    if violations.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "接頭辞の規則（RT1）に反するテスト名:\n{}",
            violations.join("\n")
        ))
    }
}

/// DS-13: DB を使う統合テスト（実 PostgreSQL）が、一定数あること（テストが消える・スキップされるだけで緑になるのを防ぐ）。
/// Docker が無いときは、`CI` 環境変数があれば各テストが失敗する（`start()` の規則）。ここでは、件数の下限を守る。
#[test]
fn ds13_実_postgresql_を使う統合テストが一定数ある() -> Result<(), String> {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = Vec::new();
    rust_files(&crates, &mut files).map_err(|e| e.to_string())?;
    let mut db_tests = 0;
    for file in files {
        let source = fs::read_to_string(&file).map_err(|e| e.to_string())?;
        db_tests += source.matches("start().await?").count();
    }
    if db_tests >= 40 {
        Ok(())
    } else {
        Err(format!(
            "実 PostgreSQL を使う統合テストが少ない（{db_tests} 件。下限 40）"
        ))
    }
}
