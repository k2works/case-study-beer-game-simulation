//! 守りの検査（DS-1〜4）。
//!
//! - DS-1〜3: 規則を破る fixture が、期待の lint で失敗することを `tests/lint_guards.rs` で確かめる。
//! - DS-4: domain の依存方向を `tests/architecture.rs` で検査する。検査の本体は、ここの純粋関数。

/// domain が依存してはならないクレート（設計: domain は I/O に依存しない。tech-stack の R4）。
pub const DOMAIN_FORBIDDEN: &[&str] = &[
    "tokio",
    "sqlx",
    "axum",
    "hyper",
    "tower",
    "tower-http",
    "reqwest",
    "tracing",
    "futures",
    "rand",
    "getrandom",
    "beergame-application",
    "beergame-adapter-http",
    "beergame-adapter-persistence",
    "beergame-app",
];

/// application が依存してはならないクレート（DB・HTTP は、アダプターが実装する。設計: architecture-backend）。
pub const APPLICATION_FORBIDDEN: &[&str] = &[
    "sqlx",
    "axum",
    "hyper",
    "tower",
    "tower-http",
    "reqwest",
    "beergame-adapter-http",
    "beergame-adapter-persistence",
    "beergame-app",
];

/// `cargo tree --prefix none` の出力から、禁止されたクレートの名前を返す（重複なし、出現順）。
#[must_use]
pub fn forbidden_dependencies(tree: &str, forbidden: &[&str]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for name in tree
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .filter(|name| forbidden.contains(name))
    {
        if !found.iter().any(|f| f == name) {
            found.push(name.to_owned());
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ds4_禁止されたクレートへの依存を検出する() {
        let tree = "beergame-domain v0.1.0 (/x)\nthiserror v2.0.21\ntokio v1.54.1\nsqlx v0.9.1\ntokio v1.54.1\n";
        assert_eq!(
            forbidden_dependencies(tree, DOMAIN_FORBIDDEN),
            vec!["tokio".to_owned(), "sqlx".to_owned()]
        );
    }

    #[test]
    fn ds4_許可された依存だけなら空() {
        let tree =
            "beergame-domain v0.1.0 (/x)\nthiserror v2.0.21\nthiserror-impl v2.0.21 (proc-macro)\n";
        assert!(forbidden_dependencies(tree, DOMAIN_FORBIDDEN).is_empty());
    }
}

/// テスト名の接頭辞（RT1。DS-10）。AC・US の ID で始めるか、技術的なテストの分類の接頭辞で始める。
/// 例: `ac2_4_1__…`、`us2_4__…`、`ds4_…`、`nf_r18__…`、`adr_020__…`、`rb2__…`、`execute__…`、`evolve__…`、`replay__…`、`tech__…`。
#[must_use]
pub fn has_valid_test_prefix(name: &str) -> bool {
    let digits_then = |rest: &str| {
        // `2_4_1_` のように、数字と `_` が続き、数字のあとの `_` で終わる
        let mut seen_digit = false;
        let mut last_was_underscore = false;
        let mut consumed = 0;
        for (i, c) in rest.char_indices() {
            if c.is_ascii_digit() {
                seen_digit = true;
                last_was_underscore = false;
                consumed = i + 1;
            } else if c == '_' && seen_digit && !last_was_underscore {
                last_was_underscore = true;
                consumed = i + 1;
            } else {
                break;
            }
        }
        seen_digit && last_was_underscore && consumed > 0
    };
    for id_prefix in ["ac", "us", "ds"] {
        if let Some(rest) = name.strip_prefix(id_prefix)
            && digits_then(rest)
        {
            return true;
        }
    }
    if let Some(rest) = name.strip_prefix('x')
        && rest.starts_with(|c: char| c.is_ascii_digit())
        && rest.contains("__")
    {
        return true;
    }
    [
        "nf_",
        "adr_",
        "d7__",
        "evolve__",
        "replay__",
        "rb2__",
        "execute__",
        "tech__",
    ]
    .iter()
    .any(|p| name.starts_with(p))
}

/// ソースから、`#[test]`・`#[tokio::test]` の関数の名前を拾う。
#[must_use]
pub fn test_names(source: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut pending = false;
    for line in source.lines().map(str::trim) {
        if line.starts_with("#[test]") || line.starts_with("#[tokio::test") {
            pending = true;
        } else if pending {
            let rest = line.strip_prefix("async ").unwrap_or(line);
            if let Some(after) = rest.strip_prefix("fn ") {
                let name: String = after
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                names.push(name);
                pending = false;
            } else if !line.starts_with("#[") && !line.is_empty() {
                pending = false;
            }
        }
    }
    names
}

#[cfg(test)]
mod naming_tests {
    use super::*;

    #[test]
    fn ds10_接頭辞の規則() {
        for ok in [
            "ac2_4_1__x",
            "ac2_4_1_ac2_4_2__x",
            "us2_4__x",
            "ds4_x",
            "nf_r18__x",
            "adr_020__x",
            "x3__x",
            "rb2__x",
            "tech__x",
            "execute__x",
        ] {
            assert!(has_valid_test_prefix(ok), "{ok}");
        }
        for ng in ["投影は純粋", "ac_x", "ac2_4", "us__x", "foo__bar", "xray"] {
            assert!(!has_valid_test_prefix(ng), "{ng}");
        }
    }

    #[test]
    fn ds10_テストの関数名を拾う() {
        let src = "#[test]\nfn a() {}\n#[tokio::test]\nasync fn b() {}\nfn not_test() {}\n#[tokio::test]\n#[allow(x)]\nasync fn c() {}\n";
        assert_eq!(
            test_names(src),
            vec!["a".to_owned(), "b".to_owned(), "c".to_owned()]
        );
    }
}
