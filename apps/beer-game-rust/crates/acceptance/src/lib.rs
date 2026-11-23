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
        // ルールを別のフィーチャーに展開したファイル（`a~rule1.feature`）は、元のファイル名で照合する
        let path = without_rule_mark(path);
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

/// ルールの部分を切り出したフィーチャーの、ファイル名の目印（`<名前>~rule1.feature`）。
pub const RULE_MARK: &str = "~rule";

/// `ルール:` を含むフィーチャーを、ルールごとに別のフィーチャーへ展開する（Rust の gherkin は `ルール:` を解析できないため。
/// 共有する feature は変更せず、実行用のコピーだけを変える）。戻り値は（ファイル名の目印, 本文）。
/// 目印が空の 1 件目は、ルールより前の部分（ルールを含まなければ、本文そのまま）。
/// ルールの中の `背景:` は、そのルールのシナリオにだけ効くので、ルールごとの別のフィーチャーに置けば意味が保てる。
#[must_use]
pub fn split_rules(text: &str) -> Vec<(String, String)> {
    let is_rule = |line: &str| line.trim_start().starts_with("ルール:");
    if !text.lines().any(is_rule) {
        return vec![(String::new(), text.to_owned())];
    }
    // ルールの前の部分（言語の指定・機能の行・ルールより前のシナリオ）と、ルールごとの本文
    let mut head: Vec<&str> = Vec::new();
    let mut rules: Vec<Vec<&str>> = Vec::new();
    for line in text.lines() {
        if is_rule(line) {
            rules.push(Vec::new());
        } else if let Some(rule) = rules.last_mut() {
            rule.push(line);
        } else {
            head.push(line);
        }
    }
    let mut parts = vec![(String::new(), head.join("\n") + "\n")];
    for (index, body) in rules.iter().enumerate() {
        let number = index + 1;
        let text = format!(
            "# language: ja\n機能: ルール {number}\n\n{}\n",
            body.join("\n")
        );
        parts.push((format!("{RULE_MARK}{number}"), text));
    }
    parts
}

/// 許可リストの照合のために、展開したファイル名から目印を取り除く（`a~rule1.feature` → `a.feature`）。
#[must_use]
pub fn without_rule_mark(path: &str) -> String {
    match path.rfind(RULE_MARK) {
        Some(start) if path.ends_with(".feature") => {
            format!("{}.feature", path.get(..start).unwrap_or(path))
        }
        _ => path.to_owned(),
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

    const WITH_RULE: &str = "# language: ja\n機能: x\n\n  @api\n  シナリオ: 前\n    前提 a\n\n  ルール: 1 つ目\n\n    背景:\n      前提 b\n\n    @api\n    シナリオ: 中 1\n      前提 c\n\n  ルール: 2 つ目\n\n    @api\n    シナリオ: 中 2\n      前提 d\n";

    #[test]
    fn tech__ルールの無いフィーチャーは_そのまま_1_件() {
        let parts = split_rules("機能: x\n  シナリオ: a\n    前提 b\n");
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].0, "");
        assert!(parts[0].1.contains("シナリオ: a"));
    }

    #[test]
    fn tech__ルールごとに別のフィーチャーへ展開し_背景はそのルールだけに付く() {
        let parts = split_rules(WITH_RULE);
        assert_eq!(parts.len(), 3);
        // ルールより前の部分には、ルールの背景もルールのシナリオも入らない
        assert!(parts[0].1.contains("シナリオ: 前") && !parts[0].1.contains("背景:"));
        assert!(!parts[0].1.contains("ルール:") && !parts[0].1.contains("中 1"));
        // 1 つ目のルール: 背景と自分のシナリオだけ
        assert_eq!(parts[1].0, "~rule1");
        assert!(parts[1].1.contains("背景:") && parts[1].1.contains("中 1"));
        assert!(!parts[1].1.contains("中 2") && !parts[1].1.contains("シナリオ: 前"));
        // 2 つ目のルール: 背景は持たない（1 つ目の背景は効かない）
        assert_eq!(parts[2].0, "~rule2");
        assert!(parts[2].1.contains("中 2") && !parts[2].1.contains("背景:"));
        // どの部分も、言語の指定と機能の行を持つ（単独で解析できる）
        assert!(
            parts
                .iter()
                .all(|(_, body)| body.contains("# language: ja") && body.contains("機能:"))
        );
    }

    #[test]
    fn tech__展開したファイル名の目印は_許可リストの照合のために取り除ける() {
        assert_eq!(
            without_rule_mark("/x/operations/metrics-and-alarms~rule1.feature"),
            "/x/operations/metrics-and-alarms.feature"
        );
        assert_eq!(without_rule_mark("/x/a.feature"), "/x/a.feature");
    }

    #[test]
    fn tech__展開したフィーチャーのシナリオも_許可リストの名前で許される() {
        let list = Allowlist::parse("operations/m.feature :: 中 1\n");
        assert!(list.allows("/t/operations/m~rule1.feature", "中 1"));
        assert!(!list.allows("/t/operations/m~rule1.feature", "中 2"));
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
