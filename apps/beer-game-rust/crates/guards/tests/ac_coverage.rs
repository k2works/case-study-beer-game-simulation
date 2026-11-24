//! DS-11: 許可リストの共有シナリオ（`@api`）が持つ AC の ID に、Rust のテストが対応している。
//! 対応のない AC があれば失敗にする。ID とテストの対応表（`target/ac-test-map.md`）も生成する（CI の成果物）。

use std::fs;
use std::path::{Path, PathBuf};

use beergame_guards::{ac_segment, api_ac_ids, test_names};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
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
fn ds11_許可リストの_ac_のすべてに_rust_のテストが対応している() -> Result<(), String> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let allowlist = fs::read_to_string(root.join("crates/acceptance/allowlist.txt"))
        .map_err(|e| e.to_string())?;
    let features = root.join("../beer-game-features");
    let mut ids: Vec<String> = Vec::new();
    for file in allowlist
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.split("::").next().unwrap_or(l).trim().to_owned())
    {
        let text = fs::read_to_string(features.join(&file)).map_err(|e| format!("{file}: {e}"))?;
        for id in api_ac_ids(&text) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids.sort();
    let mut sources = Vec::new();
    rust_files(&root.join("crates"), &mut sources).map_err(|e| e.to_string())?;
    let mut tests: Vec<String> = Vec::new();
    for file in sources {
        tests.extend(test_names(
            &fs::read_to_string(&file).map_err(|e| e.to_string())?,
        ));
    }
    let mut table = String::from("| AC | テスト |\n| :--- | :--- |\n");
    let mut missing = Vec::new();
    for id in &ids {
        let segment = ac_segment(id);
        let matched: Vec<&String> = tests
            .iter()
            .filter(|n| n.contains(&format!("{segment}_")))
            .collect();
        if matched.is_empty() {
            missing.push(id.clone());
        }
        table.push_str(&format!(
            "| {id} | {} |\n",
            matched
                .iter()
                .map(|n| format!("`{n}`"))
                .collect::<Vec<_>>()
                .join("<br>")
        ));
    }
    let target = root.join("target");
    if target.is_dir() {
        fs::write(target.join("ac-test-map.md"), &table).map_err(|e| e.to_string())?;
    }
    if ids.len() < 10 {
        return Err(format!("AC を拾えていない（{} 件）", ids.len()));
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("対応するテストが無い AC: {missing:?}"))
    }
}
