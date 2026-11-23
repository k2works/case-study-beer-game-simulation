//! 構造化ログの捕捉（受入の試験用。AC6.1.1・X-3）。本番と同じ形式（JSON 行）のログを、メモリに溜める。
//! 溜めたものは、秘密・表示名が含まれないことの検査に使う。全プロセスで 1 つ（グローバルの購読者）。

use std::io::Write;
use std::sync::{Mutex, OnceLock};

use tracing_subscriber::fmt::MakeWriter;

static BUFFER: Mutex<Vec<u8>> = Mutex::new(Vec::new());
static INSTALLED: OnceLock<bool> = OnceLock::new();

/// 購読者の書き込み先。`BUFFER` へ追記する。
#[derive(Clone, Copy)]
struct Capturing;

struct Sink;

impl Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if let Ok(mut all) = BUFFER.lock() {
            all.extend_from_slice(buf);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for Capturing {
    type Writer = Sink;

    fn make_writer(&'a self) -> Sink {
        Sink
    }
}

/// ログの捕捉を始める（何度呼んでもよい。すでに別の購読者が入っていれば、捕捉できない）。
/// 戻り値は、捕捉が有効か。
pub fn capture_logs() -> bool {
    *INSTALLED.get_or_init(|| {
        let subscriber = tracing_subscriber::fmt()
            .json()
            .with_target(true)
            .with_writer(Capturing)
            .finish();
        tracing::subscriber::set_global_default(subscriber).is_ok()
    })
}

/// これまでに捕捉したログの全体。
#[must_use]
pub fn captured_logs() -> String {
    BUFFER
        .lock()
        .map(|all| String::from_utf8_lossy(&all).into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
#[allow(non_snake_case)] // 理由: RT1 の命名（承認済み）の `__` を使うため。
mod tests {
    use super::*;

    #[test]
    fn ac6_1_1__捕捉したログは_JSON_の行として読める() {
        assert!(capture_logs());
        tracing::info!(target: "test", correlation_id = "abc", status = 200, "捕捉の試験");
        let text = captured_logs();
        let line = text.lines().find(|l| l.contains("捕捉の試験"));
        assert!(line.is_some_and(|l| serde_json::from_str::<serde_json::Value>(l).is_ok()));
    }

    #[test]
    fn ac6_1_1__何度呼んでも_捕捉は有効のまま() {
        assert!(capture_logs());
        assert!(capture_logs());
    }
}
