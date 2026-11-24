// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 生成物と注釈の検査。
//!
//! - 生成物は、コードの注釈・設計書との突き合わせに通り、コミット済みの文書と一致する（LD-1）。
//! - 走査と突き合わせの失敗は、原因が分かる誤りとして返る（LD-2〜LD-13）。

use std::path::PathBuf;

use beergame_livingdoc::render::{Inputs, render_all, source_link};
use beergame_livingdoc::scan::{ItemKind, scan_source};
use beergame_livingdoc::{Error, Generated, generate, stale_documents};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

/// LD-1: 生成物は、コミット済みの文書と一致する。差があれば `just livingdoc` で再生成する。
#[test]
fn adr_002__committed_documents_match_the_code() {
    let root = repo_root();
    let documents = generate(&root).expect("注釈と設計書の突き合わせに通る");
    let stale = stale_documents(&root, &documents);
    assert!(
        stale.is_empty(),
        "コードの注釈と、コミット済みの生成物が違う。`just livingdoc` で再生成する: {stale:?}"
    );
}

/// LD-1: 生成するのは、決めた 6 つの文書だけ。
#[test]
fn adr_002__generates_the_expected_documents() {
    let documents = generate(&repo_root()).expect("生成できる");
    let mut names: Vec<&str> = documents
        .iter()
        .filter_map(|d| d.path.rsplit('/').next())
        .collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "architecture-sightseeing-map.md",
            "core-highlight.md",
            "ddd-sightseeing-map.md",
            "events.md",
            "glossary.md",
            "walking-skeleton-tour.md",
        ]
    );
}

// ---- 走査 ----

/// LD-2: 注釈は、直後の要素（属性は飛ばす）に結び付く。enum の要素は親を持つ。
#[test]
fn adr_002__tag_binds_to_the_next_item_and_variants_know_their_parent() {
    let source = "\
/// @term 週 | 進行の単位 | AC1
#[derive(Clone)]
pub struct Week(u8);

pub enum E {
    /// @event EV-G01 | 作る
    Made { a: u8, b: Vec<(u8, u8)> },
    Plain,
}
";
    let scan = scan_source("x.rs", source).expect("走査できる");
    assert_eq!(scan.tags.len(), 2);
    let term = scan.tags.first().expect("1 つ目");
    assert_eq!(term.kind, "term");
    assert_eq!(term.fields, ["週", "進行の単位", "AC1"]);
    assert_eq!(term.item.kind, ItemKind::Type);
    assert_eq!(term.item.qualified(), "Week");
    let event = scan.tags.get(1).expect("2 つ目");
    assert_eq!(event.item.kind, ItemKind::Variant);
    assert_eq!(event.item.qualified(), "E::Made");
}

/// LD-3: enum の要素は、注釈の有無によらず集め、波括弧の中の項目名を持つ（複数行・入れ子の型を含む）。
#[test]
fn adr_002__variants_are_collected_with_their_fields() {
    let source = "\
pub enum E {
    A,
    B(u8),
    /// 外れた旧担当者
    C {
        x: BTreeMap<u8, Vec<u8>>,
        /// 昇順
        y: Option<u8>,
    },
    D { z: u8 },
}
";
    let scan = scan_source("x.rs", source).expect("走査できる");
    let fields: Vec<(&str, Vec<&str>)> = scan
        .variants
        .iter()
        .map(|v| {
            (
                v.name.as_str(),
                v.fields.iter().map(String::as_str).collect(),
            )
        })
        .collect();
    assert_eq!(
        fields,
        [
            ("A", vec![]),
            ("B", vec![]),
            ("C", vec!["x", "y"]),
            ("D", vec!["z"]),
        ]
    );
}

/// LD-4: 注釈の直後が要素でない・空行で切れている・ファイルの末尾なら、場所つきの誤りにする。
#[test]
fn adr_002__dangling_tags_are_rejected_with_a_location() {
    for (source, expect) in [
        (
            "/// @term 週 | 定義 | 出典\n\npub struct W;\n",
            "空行で切れている",
        ),
        (
            "/// @term 週 | 定義 | 出典\nlet x = 1;\n",
            "要素の宣言ではない",
        ),
        ("/// @term 週 | 定義 | 出典\n", "ファイルの末尾"),
    ] {
        let error = scan_source("x.rs", source).expect_err("誤りになる");
        let text = error.to_string();
        assert!(text.contains("x.rs:1"), "{text}");
        assert!(text.contains(expect), "{text}");
    }
}

/// LD-5: 空の項目・内容の無い注釈は誤りにする。
#[test]
fn adr_002__malformed_tags_are_rejected() {
    for source in [
        "/// @term 週 |  | 出典\npub struct W;\n",
        "/// @term\npub struct W;\n",
    ] {
        assert!(scan_source("x.rs", source).is_err(), "{source}");
    }
}

// ---- 突き合わせ ----

const BASE: &str = "\
pub enum GameEvent {
    /// @event EV-G01 | 作成
    Created { id: u8 },
}
pub enum SessionEvent {
    /// @event EV-S01 | 開始
    Started,
}
/// @tour walking-skeleton 10 準備 | 入口 | 発行するイベント: EV-G01
pub fn create() {}
/// @landmark ddd 戦略的設計 | 見どころ
pub fn a() {}
/// @landmark architecture 核 | 見どころ
pub fn b() {}
";

fn inputs() -> Inputs {
    Inputs {
        projection_source: String::new(),
        kotlin_domain_model: "| EV-G01 | `Created` | x |\n| EV-S01 | `Started` | y |\n".to_owned(),
        rust_domain_model: "（中核: 計算・進行、補完: 準備）".to_owned(),
        crate_manifests: Vec::new(),
    }
}

fn render(source: &str) -> Result<Vec<Generated>, Error> {
    let scan = scan_source("x.rs", source)?;
    render_all(&scan, &inputs())
}

/// 失敗するはずの入力の、誤りの文。成功してしまったら、検査の文字列に当たらず、テストが落ちる。
fn rendered_error(source: &str) -> String {
    match render(source) {
        Err(error) => error.to_string(),
        Ok(_) => "（誤りにならなかった）".to_owned(),
    }
}

/// LD-6: 最小の入力は、通る。
#[test]
fn adr_002__the_base_fixture_renders() {
    let documents = render(BASE).expect("生成できる");
    assert_eq!(documents.len(), 6);
}

/// LD-7: @event の無いイベントは、誤りにする（注釈の付け忘れ）。
#[test]
fn adr_002__an_event_without_a_tag_is_rejected() {
    let source = BASE.replace("    /// @event EV-S01 | 開始\n", "");
    assert!(rendered_error(&source).contains("Started"));
}

/// LD-8: ID の形・ストリームの接頭辞・重複を検査する。
#[test]
fn adr_002__event_ids_are_validated() {
    let wrong_prefix = BASE.replace("EV-S01", "EV-G01");
    assert!(rendered_error(&wrong_prefix).contains("EV-S"));
    let duplicate = BASE.replace(
        "    Created { id: u8 },",
        "    Created { id: u8 },\n    /// @event EV-G01 | 重複\n    Again,",
    );
    assert!(rendered_error(&duplicate).contains("重複"));
}

/// LD-9: 設計書の表と、名前が違えば誤りにする。意図した差は、3 番目の項目で明示できる。
#[test]
fn adr_002__event_names_are_reconciled_with_the_design() {
    let renamed = BASE.replace("Created {", "Made {");
    let text = rendered_error(&renamed);
    assert!(
        text.contains("EV-G01") && text.contains("Created"),
        "{text}"
    );
    let aliased = renamed.replace("| 作成", "| 作成 | Created");
    let documents = render(&aliased).expect("明示した差は通る");
    let events = documents
        .iter()
        .find(|d| d.path.ends_with("events.md"))
        .expect("events.md");
    assert!(events.content.contains("設計書では `Created`"));
}

/// LD-10: 設計書の表に無いイベントは、誤りにする。設計書にあって未実装のイベントは、一覧に載せる。
#[test]
fn adr_002__design_only_events_are_listed_and_code_only_events_are_rejected() {
    let source = BASE.replace("EV-S01", "EV-S02");
    assert!(rendered_error(&source).contains("EV-S02"));
    let mut with_missing = inputs();
    with_missing
        .kotlin_domain_model
        .push_str("| EV-S07 | `AutoCommitChanged` | z |\n");
    let scan = scan_source("x.rs", BASE).expect("走査できる");
    let documents = render_all(&scan, &with_missing).expect("生成できる");
    let events = documents
        .iter()
        .find(|d| d.path.ends_with("events.md"))
        .expect("events.md");
    assert!(events.content.contains("EV-S07 `AutoCommitChanged`"));
}

/// LD-11: 補完・一般のコンテキストの @core は誤りにする。数の上限も守る。
#[test]
fn adr_002__core_tags_are_limited_to_core_contexts_and_a_small_number() {
    let outside = format!("{BASE}/// @core 準備 | 補完の概念\npub fn c() {{}}\n");
    assert!(rendered_error(&outside).contains("中核"));
    let inside = format!("{BASE}/// @core 計算 | 核心\npub fn c() {{}}\n");
    assert!(render(&inside).is_ok());
    let mut many = String::from(BASE);
    for n in 0..11 {
        many.push_str(&format!("/// @core 計算 | 核心 {n}\npub fn f{n}() {{}}\n"));
    }
    assert!(rendered_error(&many).contains("上限"));
}

/// LD-12: 見どころは、地図ごとに 10 個までで、区分は地図が決める。
#[test]
fn adr_002__landmarks_are_limited_and_sections_are_known() {
    let mut many = String::from(BASE);
    for n in 0..10 {
        many.push_str(&format!(
            "/// @landmark ddd 戦術的設計 | 見どころ {n}\npub fn m{n}() {{}}\n"
        ));
    }
    assert!(rendered_error(&many).contains("絞る"));
    let unknown_section = BASE.replace("戦略的設計", "存在しない区分");
    assert!(rendered_error(&unknown_section).contains("区分"));
    let unknown_map = BASE.replace("@landmark ddd", "@landmark nowhere");
    assert!(rendered_error(&unknown_map).contains("未知の地図"));
}

/// LD-13: ツアーは、順位の重複・不正な順位・未知のツアー・存在しないイベントの参照を誤りにする。未知の注釈も誤りにする。
#[test]
fn adr_002__tours_and_unknown_tags_are_validated() {
    let duplicate = format!("{BASE}/// @tour walking-skeleton 10 プレイ | 重複\npub fn d() {{}}\n");
    assert!(rendered_error(&duplicate).contains("順位 10 が重複"));
    let bad_rank = BASE.replace("walking-skeleton 10", "walking-skeleton ten");
    assert!(rendered_error(&bad_rank).contains("整数"));
    let unknown_tour = BASE.replace("walking-skeleton 10", "nowhere 10");
    assert!(rendered_error(&unknown_tour).contains("未知のツアー"));
    let missing_event = BASE.replace("発行するイベント: EV-G01", "発行するイベント: EV-G99");
    assert!(rendered_error(&missing_event).contains("EV-G99"));
    let unknown_tag = format!("{BASE}/// @nonsense 何か\npub fn e() {{}}\n");
    assert!(rendered_error(&unknown_tag).contains("未知の注釈"));
}

/// LD-16: 「場所」は、develop ブランチのファイルへのリンク（行番号なし）。コア・ツアー・マップのすべてで同じ形にする。
#[test]
fn adr_002__locations_are_links_to_the_source() {
    let link =
        "[`x.rs`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/x.rs)";
    assert_eq!(source_link("x.rs"), link);
    let source = format!("{BASE}/// @core 計算 | 核心\npub fn c() {{}}\n");
    let documents = render(&source).expect("生成できる");
    for name in [
        "core-highlight.md",
        "walking-skeleton-tour.md",
        "ddd-sightseeing-map.md",
        "architecture-sightseeing-map.md",
    ] {
        let document = documents
            .iter()
            .find(|d| d.path.ends_with(name))
            .expect("文書がある");
        assert!(document.content.contains(link), "{name}: {link}");
        assert!(!document.content.contains("場所: `"), "{name}");
    }
}

/// LD-14: 同じ入力からは、同じ文書ができる（生成は決定的）。
#[test]
fn adr_002__generation_is_deterministic() {
    assert_eq!(render(BASE).expect("1 回目"), render(BASE).expect("2 回目"));
}

/// LD-15: 用語は重複を許さず、3 項目（用語・定義・出典）を必須にする。
#[test]
fn adr_002__terms_are_unique_and_complete() {
    let twice = format!(
        "{BASE}/// @term 週 | 定義 | 出典\npub struct W1;\n/// @term 週 | 別の定義 | 出典\npub struct W2;\n"
    );
    assert!(rendered_error(&twice).contains("重複"));
    let short = format!("{BASE}/// @term 週 | 定義だけ\npub struct W;\n");
    assert!(rendered_error(&short).contains("3 項目"));
}
