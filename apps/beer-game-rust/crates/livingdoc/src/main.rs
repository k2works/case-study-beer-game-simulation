//! `generate`: 生成物を書く。`check`: コミット済みの生成物との差を調べる（差があれば終了コード 1）。

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use beergame_livingdoc::{generate, stale_documents, write_all};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

fn say(message: &str) {
    // 標準出力への書き込みの失敗は、終了コードに影響させない
    if writeln!(std::io::stdout(), "{message}").is_err() {
        // 出力先が閉じている。何もできない
    }
}

fn main() -> ExitCode {
    let command = std::env::args().nth(1).unwrap_or_default();
    let root = repo_root();
    let documents = match generate(&root) {
        Ok(documents) => documents,
        Err(error) => {
            say(&format!("生成に失敗した: {error}"));
            return ExitCode::FAILURE;
        }
    };
    match command.as_str() {
        "generate" => match write_all(&root, &documents) {
            Ok(()) => {
                for document in &documents {
                    say(&format!("書いた: {}", document.path));
                }
                ExitCode::SUCCESS
            }
            Err(error) => {
                say(&format!("書き込みに失敗した: {error}"));
                ExitCode::FAILURE
            }
        },
        "check" => {
            let stale = stale_documents(&root, &documents);
            if stale.is_empty() {
                say("生成物は、コードと一致している");
                ExitCode::SUCCESS
            } else {
                for path in stale {
                    say(&format!("古い: {path}（`just livingdoc` で再生成する）"));
                }
                ExitCode::FAILURE
            }
        }
        other => {
            say(&format!(
                "使い方: livingdoc generate | check（`{other}` は未知）"
            ));
            ExitCode::FAILURE
        }
    }
}
