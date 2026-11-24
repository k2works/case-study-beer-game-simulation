//! 走査の結果から、文書を作る。

use std::collections::{BTreeMap, BTreeSet};

use crate::scan::{Scan, Tag, Variant};
use crate::{Error, Generated, OUTPUT_DIR};

/// 文字列へ書式つきで足す（`write!` の戻り値を捨てずに済ませる）。
macro_rules! emit {
    ($out:expr, $($arg:tt)*) => {
        $out.push_str(&format!($($arg)*))
    };
}

/// `emit!` に改行を足す。
macro_rules! emitln {
    ($out:expr, $($arg:tt)*) => {{
        $out.push_str(&format!($($arg)*));
        $out.push('\n');
    }};
}

/// 層の順（内側から外側）。依存の向きの説明に使う。
pub const LAYERS: &[&str] = &[
    "domain",
    "application",
    "adapter-persistence",
    "adapter-http",
    "app",
];

/// 注釈の外の入力（コードと突き合わせる相手）。
#[derive(Clone, Debug, Default)]
pub struct Inputs {
    pub projection_source: String,
    pub kotlin_domain_model: String,
    pub rust_domain_model: String,
    /// `LAYERS` の順の、`Cargo.toml` の本文。
    pub crate_manifests: Vec<(String, String)>,
}

/// ガイドツアーの定義（注釈 `@tour` の最初の語と対応する）。
struct TourDef {
    id: &'static str,
    file: &'static str,
    title: &'static str,
    description: &'static str,
    intro: &'static str,
}

const TOURS: &[TourDef] = &[TourDef {
    id: "walking-skeleton",
    file: "walking-skeleton-tour.md",
    title: "ウォーキングスケルトン",
    description: "最初の縦の切片（1 ゲーム・4 役割・1 週）を、入口の関数からイベントと状態の表示まで、操作の順にたどる案内。コードの走査から生成する。手で編集しない。",
    intro: "最初の縦の切片（1 ゲーム・4 役割・1 週）を、準備（作成・参加・割り当て・開始）とプレイ（入力・確定・状態の表示）の操作の順に案内する。",
}];

/// サイトシーイング・マップの定義（注釈 `@landmark` の最初の語と対応する）。
struct MapDef {
    id: &'static str,
    file: &'static str,
    title: &'static str,
    description: &'static str,
    intro: &'static str,
    /// 区分の順と、区分の説明。
    sections: &'static [(&'static str, &'static str)],
    with_layers: bool,
}

const MAPS: &[MapDef] = &[
    MapDef {
        id: "ddd",
        file: "ddd-sightseeing-map.md",
        title: "DDD",
        description: "ドメイン駆動設計（戦略的設計と戦術的設計）の見どころを、注釈 @landmark から動的に選び出し、順序なしで区分ごとに示す。まず見るべき場所の地図。手で編集しない。",
        intro: "このアプリケーションの設計は、**戦略的設計（言葉と、力を注ぐ場所）と、戦術的設計（モデルの部品）**で読む。まず見るべき場所を絞って示す。",
        sections: &[
            (
                "戦略的設計",
                "業務の言葉をそろえ、力を注ぐ場所（中核）を決める。何を作り込み、何を割り切るかの判断",
            ),
            (
                "戦術的設計",
                "モデルの部品。集約が規則を持ち、事実（イベント）だけを返し、状態は事実を畳み込んで得る",
            ),
        ],
        with_layers: false,
    },
    MapDef {
        id: "architecture",
        file: "architecture-sightseeing-map.md",
        title: "アーキテクチャ",
        description: "アプリケーションアーキテクチャの見どころを、注釈 @landmark から動的に選び出し、順序なしで層ごとに示す。まず見るべき場所の地図。手で編集しない。",
        intro: "このアプリケーションは、**副作用を持たない核**と、**副作用を持つ外側**に分かれる。まず見るべき場所を層ごとに示す。",
        sections: &[
            (
                "核",
                "副作用を持たない純粋な規則。入力から結果を決める。テストが速く、同じ入力は同じ結果になる",
            ),
            (
                "境界",
                "核と外側のつなぎ目。ポート（トレイト）で外側の実装を隠し、コマンドの実行手順を持つ",
            ),
            (
                "副作用",
                "データベースと HTTP。ポートを実装し、核が決めた結果を永続化・送受信する",
            ),
        ],
        with_layers: true,
    },
];

/// コアのハイライトの上限（付ける数は絞る）。
pub const CORE_LIMIT: usize = 10;
/// 見どころの上限。
pub const LANDMARK_LIMIT: usize = 10;

/// すべての文書を作る。
///
/// # Errors
/// 注釈の不正、コードと設計書の不一致。
pub fn render_all(scan: &Scan, inputs: &Inputs) -> Result<Vec<Generated>, Error> {
    let events = collect_events(scan, inputs)?;
    let mut documents = vec![
        doc("events.md", render_events(&events, inputs)?),
        doc("glossary.md", render_glossary(scan)?),
        doc("core-highlight.md", render_core(scan, inputs, &events)?),
    ];
    for tour in TOURS {
        documents.push(doc(tour.file, render_tour(scan, tour, &events)?));
    }
    for map in MAPS {
        documents.push(doc(map.file, render_map(scan, map, inputs)?));
    }
    reject_unknown_tags(scan)?;
    Ok(documents)
}

fn doc(file: &str, content: String) -> Generated {
    Generated {
        path: format!("{OUTPUT_DIR}/{file}"),
        content,
    }
}

fn header(title: &str, description: &str) -> String {
    format!(
        "---\ntype: Design\ntitle: \"{title}\"\ndescription: \"{description}\"\ntags: [design, generated]\nstatus: draft\ngenerated: {{ by: beergame-livingdoc }}\n---\n\n# {title}\n\nこの文書は、コードの注釈とソースから生成した。手で編集しない（試験 `livingdoc` が、コードとの差で失敗する）。再生成: `just livingdoc`（`cargo run -q -p beergame-livingdoc -- generate`）。\n\n"
    )
}

fn reject_unknown_tags(scan: &Scan) -> Result<(), Error> {
    for tag in &scan.tags {
        if !["event", "term", "core", "tour", "landmark"].contains(&tag.kind.as_str()) {
            return Err(Error::new(format!(
                "{}:{}: 未知の注釈 @{}",
                tag.file, tag.line, tag.kind
            )));
        }
    }
    Ok(())
}

fn table_cell(text: &str) -> String {
    text.replace('|', "\\|")
}

// ---------------------------------------------------------------- イベント

#[derive(Clone, Debug)]
struct EventRow {
    id: String,
    name: String,
    stream: &'static str,
    condition: String,
    fields: Vec<String>,
    projections: Vec<String>,
    design_name: Option<String>,
    file: String,
}

fn stream_of(enum_name: &str) -> Option<(&'static str, &'static str)> {
    match enum_name {
        "GameEvent" => Some(("game", "EV-G")),
        "SessionEvent" => Some(("session", "EV-S")),
        _ => None,
    }
}

fn collect_events(scan: &Scan, inputs: &Inputs) -> Result<Vec<EventRow>, Error> {
    let projections = projections_by_event(&inputs.projection_source);
    let variants: BTreeMap<(String, String), &Variant> = scan
        .variants
        .iter()
        .filter(|v| stream_of(&v.enum_name).is_some())
        .map(|v| ((v.enum_name.clone(), v.name.clone()), v))
        .collect();
    let mut rows: Vec<EventRow> = Vec::new();
    let mut tagged: BTreeSet<(String, String)> = BTreeSet::new();
    for tag in scan.tags_of("event") {
        let parent = tag.item.parent.clone().unwrap_or_default();
        let Some((stream, prefix)) = stream_of(&parent) else {
            return Err(Error::new(format!(
                "{}:{}: @event は GameEvent・SessionEvent の要素にだけ付ける",
                tag.file, tag.line
            )));
        };
        let id = tag.field(0).to_owned();
        let valid = id
            .strip_prefix(prefix)
            .is_some_and(|n| n.len() == 2 && n.chars().all(|c| c.is_ascii_digit()));
        if !valid {
            return Err(Error::new(format!(
                "{}:{}: イベントの ID `{id}` は、`{prefix}` と 2 桁の数にする",
                tag.file, tag.line
            )));
        }
        if rows.iter().any(|row| row.id == id) {
            return Err(Error::new(format!(
                "{}:{}: イベントの ID `{id}` が重複している",
                tag.file, tag.line
            )));
        }
        tagged.insert((parent.clone(), tag.item.name.clone()));
        let fields = variants
            .get(&(parent.clone(), tag.item.name.clone()))
            .map(|v| v.fields.clone())
            .unwrap_or_default();
        rows.push(EventRow {
            id,
            name: tag.item.name.clone(),
            stream,
            condition: tag.field(1).to_owned(),
            fields,
            projections: projections
                .get(&format!("{parent}::{}", tag.item.name))
                .cloned()
                .unwrap_or_default(),
            design_name: tag.fields.get(2).cloned(),
            file: tag.file.clone(),
        });
    }
    let missing: Vec<String> = variants
        .keys()
        .filter(|key| !tagged.contains(*key))
        .map(|(e, n)| format!("{e}::{n}"))
        .collect();
    if !missing.is_empty() {
        return Err(Error::new(format!(
            "注釈 @event の無いイベントがある: {}",
            missing.join("、")
        )));
    }
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(rows)
}

/// 設計書（beer-game-kotlin のドメインイベントの表）の `(ID, 名前)`。
fn design_events(kotlin_domain_model: &str) -> Vec<(String, String)> {
    kotlin_domain_model
        .lines()
        .filter(|line| line.starts_with("| EV-"))
        .filter_map(|line| {
            let mut cells = line.split('|').skip(1);
            let id = cells.next()?.trim().to_owned();
            let name_cell = cells.next()?;
            let name = name_cell.split('`').nth(1)?.to_owned();
            Some((id, name))
        })
        .collect()
}

/// `adapter-persistence` の `projection.rs` の match の腕から、イベントごとの書き込み先の表（重複なし、出現順）。
fn projections_by_event(source: &str) -> BTreeMap<String, Vec<String>> {
    let helpers = helper_tables(source);
    let mut result: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut current: Vec<String> = Vec::new();
    let mut in_header = false;
    for raw in source.lines() {
        let trimmed = raw.trim_start();
        if trimmed.starts_with("//") {
            continue;
        }
        let indent = raw.len() - trimmed.len();
        if indent == 0 && !trimmed.is_empty() {
            // 関数の終わり・次の関数。腕の外の SQL を、直前のイベントに結び付けない
            current.clear();
            in_header = false;
            continue;
        }
        let starts_arm = indent == 8
            && (trimmed.starts_with("GameEvent::") || trimmed.starts_with("SessionEvent::"));
        if starts_arm {
            current.clear();
            in_header = true;
        }
        if in_header {
            current.extend(event_paths(trimmed));
            if trimmed.contains("=>") {
                in_header = false;
                for key in &current {
                    result.entry(key.clone()).or_default();
                }
            }
        }
        let mut written = written_tables(trimmed);
        for (name, tables) in &helpers {
            if trimmed.contains(&format!("{name}(")) {
                written.extend(tables.iter().cloned());
            }
        }
        for table in written {
            for key in &current {
                let tables = result.entry(key.clone()).or_default();
                if !tables.contains(&table) {
                    tables.push(table.clone());
                }
            }
        }
    }
    result
}

/// 腕から呼ばれる補助の関数（`decision_statements` など）が書くテーブル。
/// イベントの腕を持つ関数（`game_statements`・`session_statements`）は除く。
fn helper_tables(source: &str) -> BTreeMap<String, Vec<String>> {
    let mut helpers: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut dispatchers: BTreeSet<String> = BTreeSet::new();
    let mut current: Option<String> = None;
    for raw in source.lines() {
        let trimmed = raw.trim_start();
        if trimmed.starts_with("//") {
            continue;
        }
        let indent = raw.len() - trimmed.len();
        if indent == 0 && !trimmed.is_empty() && !trimmed.starts_with(')') {
            current = fn_name(trimmed);
            if let Some(name) = &current {
                helpers.entry(name.clone()).or_default();
            }
            continue;
        }
        let Some(name) = &current else {
            continue;
        };
        if !event_paths(trimmed).is_empty() {
            dispatchers.insert(name.clone());
        }
        for table in written_tables(trimmed) {
            let tables = helpers.entry(name.clone()).or_default();
            if !tables.contains(&table) {
                tables.push(table);
            }
        }
    }
    helpers.retain(|name, tables| !dispatchers.contains(name) && !tables.is_empty());
    helpers
}

fn fn_name(top_level: &str) -> Option<String> {
    let mut rest = top_level;
    for prefix in ["pub(crate) ", "pub ", "async "] {
        rest = rest.strip_prefix(prefix).unwrap_or(rest);
    }
    let after = rest.strip_prefix("fn ")?;
    Some(
        after
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect(),
    )
}

fn event_paths(text: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for enum_name in ["GameEvent", "SessionEvent"] {
        let marker = format!("{enum_name}::");
        for part in text.split(&marker).skip(1) {
            let name: String = part
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                paths.push(format!("{enum_name}::{name}"));
            }
        }
    }
    paths
}

fn written_tables(text: &str) -> Vec<String> {
    let mut tables = Vec::new();
    for marker in ["INSERT INTO ", "UPDATE ", "DELETE FROM "] {
        for part in text.split(marker).skip(1) {
            let name: String = part
                .chars()
                .take_while(|c| c.is_ascii_lowercase() || *c == '_' || c.is_ascii_digit())
                .collect();
            if !name.is_empty() {
                tables.push(name);
            }
        }
    }
    tables
}

fn render_events(events: &[EventRow], inputs: &Inputs) -> Result<String, Error> {
    let design = design_events(&inputs.kotlin_domain_model);
    for row in events {
        let expected = row.design_name.as_deref().unwrap_or(&row.name);
        match design.iter().find(|(id, _)| *id == row.id) {
            Some((_, name)) if name == expected => {}
            Some((_, name)) => {
                return Err(Error::new(format!(
                    "{}: イベント {} の名前 `{expected}` が、設計書（beer-game-kotlin のドメインイベントの表）の `{name}` と違う（意図した差なら、注釈の 3 番目の項目に設計書での名前を書く）",
                    row.file, row.id
                )));
            }
            None => {
                return Err(Error::new(format!(
                    "{}: イベント {} `{}` が、設計書のドメインイベントの表に無い",
                    row.file, row.id, row.name
                )));
            }
        }
    }
    let mut out = header(
        "イベント一覧（生成）",
        "ドメインイベントの一覧。コードの注釈とソースから生成した。手で編集しない。",
    );
    emit!(
        out,
        "実装済みのドメインイベント {} 種類。ID は beer-game-kotlin の[ドメインモデル設計](../../beer-game-kotlin/domain-model.md)の「ドメインイベント」の表と同じで（[Rust 版の設計](../domain-model.md)は、この表を正本として引き継ぐ）、\n名前が違うとき、または実装にあって設計書の表に無いときは、試験が失敗する。\nストリームとペイロードの項目は型から、書き込む投影のテーブルは `adapter-persistence` の `projection.rs` の走査から、発生する条件は注釈 `@event` から作る。\n\n",
        events.len()
    );
    out.push_str("| ID | イベント | ストリーム | 発生する条件 | ペイロードの項目 | 書き込む投影のテーブル |\n| :--- | :--- | :--- | :--- | :--- | :--- |\n");
    for row in events {
        let name = match &row.design_name {
            Some(design_name) => format!("`{}`（設計書では `{design_name}`）", row.name),
            None => format!("`{}`", row.name),
        };
        emitln!(
            out,
            "| {} | {} | {} | {} | {} | {} |",
            row.id,
            name,
            row.stream,
            table_cell(&row.condition),
            code_list(&row.fields),
            code_list(&row.projections),
        );
    }
    let implemented: BTreeSet<&str> = events.iter().map(|row| row.id.as_str()).collect();
    let missing: Vec<&(String, String)> = design
        .iter()
        .filter(|(id, _)| !implemented.contains(id.as_str()))
        .collect();
    if !missing.is_empty() {
        out.push_str("\n## 設計書にあり、まだ実装が無いイベント\n\n");
        for (id, name) in missing {
            emitln!(out, "- {id} `{name}`");
        }
    }
    Ok(out)
}

fn code_list(items: &[String]) -> String {
    if items.is_empty() {
        "なし".to_owned()
    } else {
        items
            .iter()
            .map(|item| format!("`{item}`"))
            .collect::<Vec<_>>()
            .join("、")
    }
}

// ---------------------------------------------------------------- 用語集

fn render_glossary(scan: &Scan) -> Result<String, Error> {
    let mut terms: Vec<&Tag> = scan.tags_of("term").collect();
    terms.sort_by(|a, b| a.field(0).cmp(b.field(0)));
    for pair in terms.windows(2) {
        if let [a, b] = pair
            && a.field(0) == b.field(0)
        {
            return Err(Error::new(format!(
                "{}:{}: 用語 `{}` が重複している（{}:{}）",
                b.file,
                b.line,
                b.field(0),
                a.file,
                a.line
            )));
        }
    }
    for tag in &terms {
        if tag.fields.len() != 3 {
            return Err(Error::new(format!(
                "{}:{}: @term は `用語 | 定義 | 出典` の 3 項目にする",
                tag.file, tag.line
            )));
        }
    }
    let mut out = header(
        "用語集（生成）",
        "ユビキタス言語の用語集。コードの注釈 @term から生成した。手で編集しない。",
    );
    emit!(
        out,
        "注釈 `@term` を付けた要素の {} 項目。これから書くコードと、新しく足す概念から付け始める（既存コードへの一括適用はしない）。\n全体のユビキタス言語は[ドメインモデル設計](../domain-model.md)と、beer-game-kotlin の[ドメインモデル設計](../../beer-game-kotlin/domain-model.md)の「ユビキタス言語」を参照する。\n\n",
        terms.len()
    );
    out.push_str("| 用語 | コード上の名称 | 定義 | 出典 |\n| :--- | :--- | :--- | :--- |\n");
    for tag in terms {
        emitln!(
            out,
            "| {} | `{}` | {} | {} |",
            table_cell(tag.field(0)),
            tag.item.qualified(),
            table_cell(tag.field(1)),
            table_cell(tag.field(2)),
        );
    }
    Ok(out)
}

// ---------------------------------------------------------------- コアのハイライト

/// 設計書の「中核: A・B、補完: …」の A・B。
fn core_contexts(rust_domain_model: &str) -> Vec<String> {
    rust_domain_model
        .lines()
        .find_map(|line| {
            let after = line.split("中核:").nth(1)?;
            let list = after.split(['、', '）']).next()?;
            Some(list.split('・').map(|c| c.trim().to_owned()).collect())
        })
        .unwrap_or_default()
}

fn render_core(scan: &Scan, inputs: &Inputs, events: &[EventRow]) -> Result<String, Error> {
    let contexts = core_contexts(&inputs.rust_domain_model);
    if contexts.is_empty() {
        return Err(Error::new(
            "設計書（domain-model.md）に「中核: …」の行が見つからない",
        ));
    }
    let tags: Vec<&Tag> = scan.tags_of("core").collect();
    if tags.len() > CORE_LIMIT {
        return Err(Error::new(format!(
            "@core が {} 個ある（上限は {CORE_LIMIT}。核心を絞る）",
            tags.len()
        )));
    }
    for tag in &tags {
        if !contexts.iter().any(|c| c == tag.field(0)) {
            return Err(Error::new(format!(
                "{}:{}: @core のコンテキスト `{}` は、設計書の「中核」（{}）にない。補完・一般のコンテキストには付けない",
                tag.file,
                tag.line,
                tag.field(0),
                contexts.join("・")
            )));
        }
    }
    let mut out = header(
        "コアのハイライト（生成）",
        "ドメインの中核（シミュレーション計算と進行）の主要な概念を、注釈 @core から動的に選び出して示す案内。新しく参加する開発者が、まず読むコードの入口になる。手で編集しない。",
    );
    emit!(
        out,
        "**ここが核心。** このゲームの中核は、遅延と意思決定が変動を増幅する過程を忠実に計算すること（{}）と、4 役割の入力を揃えて週を一度だけ確定すること（{}）。新しく参加する人は、まず下の {} つを読む。\n\n選び方: 注釈 `@core` を付けた概念だけを、コンテキストごとに示す（名前や場所は名指ししない。改名や移動に追従する）。\n中核かどうかは、[ドメインモデル設計](../domain-model.md)の「戦略的設計」が正本で、補完・一般のコンテキストの概念は載せない（試験が検出する）。付ける数は {CORE_LIMIT} 個以内に絞る。\n\n",
        contexts.first().map_or("", String::as_str),
        contexts.get(1).map_or("", String::as_str),
        tags.len()
    );
    for context in &contexts {
        let mut group: Vec<&&Tag> = tags.iter().filter(|t| t.field(0) == context).collect();
        if group.is_empty() {
            continue;
        }
        group.sort_by(|a, b| (&a.file, a.line).cmp(&(&b.file, b.line)));
        emitln!(out, "## {context}\n");
        out.push_str("| 種別 | 名前 | 場所 | なぜ核心か |\n| :--- | :--- | :--- | :--- |\n");
        for tag in group {
            emitln!(
                out,
                "| {} | `{}` | `{}` | {} |",
                tag.item.kind.label(),
                tag.item.qualified(),
                tag.file,
                table_cell(tag.field(1)),
            );
        }
        out.push('\n');
    }
    out.push_str("コアが事実として残すイベント（[イベント一覧](./events.md)）:\n\n");
    for row in events {
        emitln!(out, "- {} `{}`", row.id, row.name);
    }
    Ok(out)
}

// ---------------------------------------------------------------- ガイドツアー

fn head_tokens(tag: &Tag) -> Vec<&str> {
    tag.field(0).split_whitespace().collect()
}

fn render_tour(scan: &Scan, tour: &TourDef, events: &[EventRow]) -> Result<String, Error> {
    let mut steps: Vec<(u32, String, &Tag)> = Vec::new();
    for tag in scan.tags_of("tour") {
        let head = head_tokens(tag);
        let [id, rank, section] = head.as_slice() else {
            return Err(Error::new(format!(
                "{}:{}: @tour は `ツアー 順位 区分 | 説明` の形にする",
                tag.file, tag.line
            )));
        };
        if !TOURS.iter().any(|t| t.id == *id) {
            return Err(Error::new(format!(
                "{}:{}: 未知のツアー `{id}`",
                tag.file, tag.line
            )));
        }
        if *id != tour.id {
            continue;
        }
        let rank: u32 = rank.parse().map_err(|_| {
            Error::new(format!(
                "{}:{}: 順位は 10, 20, 30… の整数にする: `{rank}`",
                tag.file, tag.line
            ))
        })?;
        steps.push((rank, (*section).to_owned(), tag));
    }
    if steps.is_empty() {
        return Err(Error::new(format!(
            "ツアー `{}` に注釈 @tour が無い",
            tour.id
        )));
    }
    steps.sort_by(|a, b| (a.0, &a.2.file, a.2.line).cmp(&(b.0, &b.2.file, b.2.line)));
    for pair in steps.windows(2) {
        if let [a, b] = pair
            && a.0 == b.0
        {
            return Err(Error::new(format!(
                "{}:{}: ツアー `{}` の順位 {} が重複している",
                b.2.file, b.2.line, tour.id, b.0
            )));
        }
    }
    let known: BTreeSet<&str> = events.iter().map(|e| e.id.as_str()).collect();
    for (_, _, tag) in &steps {
        for extra in tag.fields.iter().skip(2) {
            for word in extra.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-')) {
                let is_event_id = word.starts_with("EV-") && word.len() == 6;
                if is_event_id && !known.contains(word) {
                    return Err(Error::new(format!(
                        "{}:{}: ツアーが示すイベント {word} が、実装に無い",
                        tag.file, tag.line
                    )));
                }
            }
        }
    }
    let mut sections: Vec<String> = Vec::new();
    for (_, section, _) in &steps {
        if !sections.contains(section) {
            sections.push(section.clone());
        }
    }
    let mut out = header(
        &format!("ガイドツアー（生成）: {}", tour.title),
        tour.description,
    );
    emit!(
        out,
        "{}（{} ステップ）\nステップは、注釈 `@tour` を付けた要素を、ソースの走査で集めて、順位（rank）の順に並べたもの（名前や場所は名指ししない）。\n各ステップの説明は、注釈の説明から取り出す。コマンドとイベントの対応は[イベント一覧](./events.md)を参照する。\n\n## 全体の流れ\n\n図の矢印は、読む順序を示す（実行時の呼び出しの順とは限らない。たとえば、問い合わせ側は投影を読むだけで、書き込みの後続ではない）。\n\n",
        tour.intro,
        steps.len()
    );
    out.push_str("```plantuml\n@startuml\nleft to right direction\n");
    for section in &sections {
        emitln!(out, "package \"{section}\" {{");
        for (number, (_, step_section, tag)) in steps.iter().enumerate() {
            if step_section == section {
                emitln!(
                    out,
                    "  rectangle \"{}. {}\" as S{}",
                    number + 1,
                    tag.item.qualified(),
                    number + 1
                );
            }
        }
        out.push_str("}\n");
    }
    for number in 1..steps.len() {
        emitln!(out, "S{number} --> S{}", number + 1);
    }
    out.push_str("@enduml\n```\n");
    let mut number = 0_usize;
    for section in &sections {
        emitln!(out, "\n### {section}");
        for (_, step_section, tag) in &steps {
            if step_section != section {
                continue;
            }
            number += 1;
            emit!(
                out,
                "\n#### {number}. `{}`（{}）\n\n{}\n\n",
                tag.item.qualified(),
                tag.item.kind.label(),
                tag.field(1)
            );
            for extra in tag.fields.iter().skip(2) {
                emit!(out, "{extra}\n\n");
            }
            emitln!(out, "場所: `{}`", tag.file);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- サイトシーイング・マップ

fn render_map(scan: &Scan, map: &MapDef, inputs: &Inputs) -> Result<String, Error> {
    let mut marks: Vec<&Tag> = Vec::new();
    for tag in scan.tags_of("landmark") {
        let head = head_tokens(tag);
        let [id, section] = head.as_slice() else {
            return Err(Error::new(format!(
                "{}:{}: @landmark は `地図 区分 | 説明` の形にする",
                tag.file, tag.line
            )));
        };
        if !MAPS.iter().any(|m| m.id == *id) {
            return Err(Error::new(format!(
                "{}:{}: 未知の地図 `{id}`",
                tag.file, tag.line
            )));
        }
        if *id != map.id {
            continue;
        }
        if !map.sections.iter().any(|(name, _)| name == section) {
            return Err(Error::new(format!(
                "{}:{}: 地図 `{id}` に区分 `{section}` は無い",
                tag.file, tag.line
            )));
        }
        marks.push(tag);
    }
    if marks.is_empty() || marks.len() > LANDMARK_LIMIT {
        return Err(Error::new(format!(
            "地図 `{}` の見どころが {} 個（1〜{LANDMARK_LIMIT} 個に絞る）",
            map.id,
            marks.len()
        )));
    }
    let section_of = |tag: &Tag| {
        head_tokens(tag)
            .get(1)
            .copied()
            .unwrap_or_default()
            .to_owned()
    };
    let mut out = header(
        &format!("サイトシーイング・マップ（生成）: {}", map.title),
        map.description,
    );
    emit!(
        out,
        "{}\n見どころは、注釈 `@landmark` を付けた要素を、ソースの走査で集めたもの（名前や場所は名指ししない）。{} 個に絞った。\n順序は付けない（処理の流れを順にたどるには、[ガイドツアー](./walking-skeleton-tour.md)を使う）。\n\n## 全体の構成\n\n見どころを、区分ごとの枠に並べる（順序は付けない。枠の間に矢印は引かない）。\n\n",
        map.intro,
        marks.len()
    );
    out.push_str("```plantuml\n@startuml\nleft to right direction\n");
    let mut count = 0_usize;
    for (section, _) in map.sections {
        let in_section: Vec<&&Tag> = marks.iter().filter(|t| section_of(t) == *section).collect();
        if in_section.is_empty() {
            continue;
        }
        emitln!(out, "package \"{section}\" {{");
        for tag in in_section {
            count += 1;
            emitln!(out, "  [{}] as L{count}", tag.item.qualified());
        }
        out.push_str("}\n");
    }
    out.push_str("@enduml\n```\n");
    if map.with_layers {
        out.push_str(&render_layers(inputs));
    }
    for (section, intro) in map.sections {
        let mut in_section: Vec<&&Tag> =
            marks.iter().filter(|t| section_of(t) == *section).collect();
        if in_section.is_empty() {
            continue;
        }
        in_section.sort_by(|a, b| (&a.file, a.line).cmp(&(&b.file, b.line)));
        emit!(out, "\n### {section}\n\n{intro}\n");
        for tag in in_section {
            emit!(
                out,
                "\n#### `{}`（{}）\n\n{}\n\n場所: `{}`\n",
                tag.item.qualified(),
                tag.item.kind.label(),
                tag.field(1),
                tag.file
            );
        }
    }
    Ok(out)
}

/// 各クレートの `Cargo.toml` の `[dependencies]` から、層の間の依存の向き。
fn render_layers(inputs: &Inputs) -> String {
    let mut out = String::from(
        "\n### 層の間の依存の向き\n\nビルドの定義（各クレートの `Cargo.toml`）から導いた、クレートの依存。内側は、外側を知らない。\n\n",
    );
    for (layer, manifest) in &inputs.crate_manifests {
        let deps = internal_dependencies(manifest);
        if deps.is_empty() {
            emitln!(
                out,
                "- `{layer}` は、どのクレートにも依存しない（最も内側）"
            );
        } else {
            emitln!(out, "- `{layer}` は {} に依存する", code_list_ja(&deps));
        }
    }
    out
}

fn code_list_ja(items: &[String]) -> String {
    items
        .iter()
        .map(|item| format!("`{item}`"))
        .collect::<Vec<_>>()
        .join("、")
}

fn internal_dependencies(manifest: &str) -> Vec<String> {
    let mut in_dependencies = false;
    let mut result = Vec::new();
    for line in manifest.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_dependencies = trimmed == "[dependencies]";
            continue;
        }
        if in_dependencies
            && let Some((name, _)) = trimmed.split_once(['=', ' '])
            && let Some(layer) = name.trim().strip_prefix("beergame-")
        {
            result.push(layer.to_owned());
        }
    }
    result.sort();
    result
}
