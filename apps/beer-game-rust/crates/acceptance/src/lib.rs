//! 受け入れテスト（Cucumber）のクレート。実行は `tests/acceptance.rs`。
//!
//! 共有する `features/`（Kotlin 版のファイル。変更しない）のうち、Rust 側で実行するシナリオを、
//! **許可リスト**（`allowlist.txt`。Rust 側のファイル）で決める（開発戦略「共有する features/ の許可リスト」）。
//! 許可したシナリオに Undefined・Pending があれば失敗にし、許可の外は「未対応」として一覧に出す。

/// 許可リスト。1 行 1 件。`#` で始まる行と空行は無視する。
///
/// - `<機能領域>/<ファイル名>.feature` … そのファイルの `@api` のシナリオすべて
/// - `<機能領域>/<ファイル名>.feature :: <シナリオ名>` … そのシナリオだけ
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Allowlist {
    entries: Vec<(String, Option<String>)>,
}

impl Allowlist {
    #[must_use]
    pub fn parse(text: &str) -> Self {
        let entries = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(|line| match line.split_once("::") {
                Some((file, scenario)) => {
                    (file.trim().to_owned(), Some(scenario.trim().to_owned()))
                }
                None => (line.to_owned(), None),
            })
            .collect();
        Allowlist { entries }
    }

    /// `path` はフィーチャーファイルのパス（末尾が `<機能領域>/<ファイル名>.feature` であればよい）。
    #[must_use]
    pub fn allows(&self, path: &str, scenario: &str) -> bool {
        self.entries.iter().any(|(file, only)| {
            path.ends_with(file.as_str()) && only.as_deref().is_none_or(|name| name == scenario)
        })
    }

    /// 許可リストが指すファイル（重複なし）。
    #[must_use]
    pub fn files(&self) -> Vec<&str> {
        let mut files: Vec<&str> = Vec::new();
        for (file, _) in &self.entries {
            if !files.contains(&file.as_str()) {
                files.push(file.as_str());
            }
        }
        files
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// フィーチャーファイルの本文から、`@api` のシナリオ名を拾う（構文は解析せず、タグの行と `シナリオ:` の行だけを見る）。
/// 未対応の一覧を出すために使う。Rust の gherkin は `ルール:` を解析できず、ディレクトリ全体を実行できないため、
/// 実行は許可したファイルだけに限り、残りはこの簡易の走査で数える。
#[must_use]
pub fn api_scenarios(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut api = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('@') {
            api = line.split_whitespace().any(|tag| tag == "@api");
        } else if let Some(name) = line
            .strip_prefix("シナリオ:")
            .or_else(|| line.strip_prefix("シナリオアウトライン:"))
        {
            if api {
                found.push(name.trim().to_owned());
            }
            api = false;
        } else if !line.starts_with('#') && !line.is_empty() {
            api = false;
        }
    }
    found
}

#[cfg(test)]
// 理由: RT1 の命名（承認済み）の `__` を使うため（rustc の non_snake_case は連続する `_` を許さない）。
#[allow(non_snake_case)]
mod tests {
    use super::*;

    const TEXT: &str = "# 説明\n\ngame-setup/co-assignment.feature\nweekly-play/decision.feature :: 数量を保存する\n";

    #[test]
    fn tech__コメントと空行を無視して読む() {
        assert_eq!(Allowlist::parse(TEXT).len(), 2);
        assert!(Allowlist::parse("# だけ\n").is_empty());
    }

    #[test]
    fn tech__ファイルの指定は_そのファイルのすべてのシナリオを許す() {
        let list = Allowlist::parse(TEXT);
        assert!(list.allows("/x/features/game-setup/co-assignment.feature", "任意"));
        assert!(!list.allows("/x/features/game-setup/joining.feature", "任意"));
    }

    #[test]
    fn tech__api_のシナリオ名だけを拾う() {
        let text = "機能: x\n  @AC1 @api @core\n  シナリオ: 拾う\n    前提 a\n  @AC2 @ui\n  シナリオ: 拾わない\n  # c\n  @api\n  # 間のコメント\n  シナリオアウトライン: 拾う 2\n";
        assert_eq!(
            api_scenarios(text),
            vec!["拾う".to_owned(), "拾う 2".to_owned()]
        );
    }

    #[test]
    fn tech__許可リストのファイルは重複なく返す() {
        assert_eq!(Allowlist::parse(TEXT).files().len(), 2);
        assert_eq!(
            Allowlist::parse("a.feature :: x\na.feature :: y\n").files(),
            vec!["a.feature"]
        );
    }

    #[test]
    fn tech__シナリオの指定は_そのシナリオだけを許す() {
        let list = Allowlist::parse(TEXT);
        assert!(list.allows("/x/weekly-play/decision.feature", "数量を保存する"));
        assert!(!list.allows("/x/weekly-play/decision.feature", "別のシナリオ"));
    }
}
