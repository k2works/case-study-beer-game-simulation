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
