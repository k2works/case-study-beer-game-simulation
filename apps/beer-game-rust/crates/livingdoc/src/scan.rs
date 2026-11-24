//! ソースの走査。doc コメントの注釈（`/// @種別 先頭 | 項目 | 項目`）と、その直後の要素を集める。
//!
//! 注釈は 1 行で完結する。直後（属性の行は飛ばす）の要素が、注釈の対象になる。
//! `enum` の要素（インデント 4）は、親の名前を持つ。

use std::fs;
use std::path::{Path, PathBuf};

use crate::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemKind {
    Type,
    Function,
    Trait,
    Constant,
    Variant,
}

impl ItemKind {
    /// 文書に出す種別の呼び名。
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            ItemKind::Type => "型",
            ItemKind::Function => "関数",
            ItemKind::Trait => "トレイト",
            ItemKind::Constant => "定数",
            ItemKind::Variant => "要素",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub kind: ItemKind,
    pub name: String,
    /// `enum` の要素のときの、親の `enum` の名前。
    pub parent: Option<String>,
}

impl Item {
    /// 文書に出すコード上の名前（`SessionState::Paused` のように親を付ける）。
    #[must_use]
    pub fn qualified(&self) -> String {
        match &self.parent {
            Some(parent) => format!("{parent}::{}", self.name),
            None => self.name.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tag {
    pub kind: String,
    /// `|` で区切った項目（前後の空白は除く）。先頭は、種別ごとの「見出し」。
    pub fields: Vec<String>,
    /// リポジトリの根からの相対パス。
    pub file: String,
    pub line: usize,
    pub item: Item,
}

impl Tag {
    #[must_use]
    pub fn field(&self, index: usize) -> &str {
        self.fields.get(index).map_or("", String::as_str)
    }
}

/// `enum` の要素の宣言（注釈の有無によらず集める。注釈の漏れを検出するため）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Variant {
    pub enum_name: String,
    pub name: String,
    pub fields: Vec<String>,
    pub file: String,
    pub line: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Scan {
    pub tags: Vec<Tag>,
    pub variants: Vec<Variant>,
}

impl Scan {
    pub fn tags_of<'a>(&'a self, kind: &'a str) -> impl Iterator<Item = &'a Tag> {
        self.tags.iter().filter(move |tag| tag.kind == kind)
    }
}

/// 1 つのソースを走査する。`file` は、文書に出す相対パス。
///
/// # Errors
/// 注釈の直後に要素が無いとき、注釈の形が不正なとき。
pub fn scan_source(file: &str, text: &str) -> Result<Scan, Error> {
    let lines: Vec<&str> = text.lines().collect();
    let mut scan = Scan::default();
    let mut current_enum: Option<String> = None;
    let mut pending: Vec<(String, Vec<String>, usize)> = Vec::new();
    for (index, raw) in lines.iter().enumerate() {
        let line_no = index + 1;
        let trimmed = raw.trim_start();
        let indent = raw.len() - trimmed.len();
        if let Some(doc) = trimmed.strip_prefix("///") {
            if let Some(body) = doc.trim().strip_prefix('@') {
                pending.push(parse_tag(file, line_no, body)?);
            }
            continue;
        }
        if trimmed.starts_with("#[") || trimmed.starts_with("//") {
            continue;
        }
        if trimmed.is_empty() {
            if let Some((kind, _, at)) = pending.first() {
                return Err(Error::new(format!(
                    "{file}:{at}: 注釈 @{kind} の直後に要素が無い（空行で切れている）"
                )));
            }
            continue;
        }
        if indent == 0 && trimmed.starts_with('}') {
            current_enum = None;
        }
        let item = parse_item(trimmed, indent, current_enum.as_deref());
        if let Some(Item {
            kind: ItemKind::Variant,
            name,
            parent: Some(parent),
        }) = &item
        {
            scan.variants.push(Variant {
                enum_name: parent.clone(),
                name: name.clone(),
                fields: variant_fields(&lines, index),
                file: file.to_owned(),
                line: line_no,
            });
        }
        if pending.is_empty() {
            update_enum(trimmed, indent, &mut current_enum);
            continue;
        }
        let Some(item) = item else {
            let (kind, _, at) = pending.remove(0);
            return Err(Error::new(format!(
                "{file}:{at}: 注釈 @{kind} の直後が、要素の宣言ではない: {trimmed}"
            )));
        };
        for (kind, fields, at) in pending.drain(..) {
            scan.tags.push(Tag {
                kind,
                fields,
                file: file.to_owned(),
                line: at,
                item: item.clone(),
            });
        }
        update_enum(trimmed, indent, &mut current_enum);
    }
    if let Some((kind, _, at)) = pending.first() {
        return Err(Error::new(format!(
            "{file}:{at}: 注釈 @{kind} の直後に要素が無い（ファイルの末尾）"
        )));
    }
    Ok(scan)
}

fn update_enum(trimmed: &str, indent: usize, current_enum: &mut Option<String>) {
    if indent != 0 {
        return;
    }
    let rest = strip_visibility(trimmed);
    if let Some(after) = rest.strip_prefix("enum ") {
        *current_enum = Some(identifier(after));
    }
}

fn parse_tag(file: &str, line: usize, body: &str) -> Result<(String, Vec<String>, usize), Error> {
    let (kind, rest) = body
        .split_once(char::is_whitespace)
        .ok_or_else(|| Error::new(format!("{file}:{line}: 注釈に内容が無い: @{body}")))?;
    if kind.is_empty() {
        return Err(Error::new(format!("{file}:{line}: 注釈の種別が空")));
    }
    let fields: Vec<String> = rest.split(" | ").map(|f| f.trim().to_owned()).collect();
    if fields.iter().any(String::is_empty) {
        return Err(Error::new(format!(
            "{file}:{line}: 注釈 @{kind} に空の項目がある"
        )));
    }
    Ok((kind.to_owned(), fields, line))
}

fn strip_visibility(text: &str) -> &str {
    let mut rest = text;
    loop {
        let before = rest;
        for prefix in ["pub(crate) ", "pub(super) ", "pub ", "async ", "unsafe "] {
            if let Some(after) = rest.strip_prefix(prefix) {
                rest = after;
            }
        }
        if let Some(after) = rest.strip_prefix("const ")
            && after.starts_with("fn ")
        {
            rest = after;
        }
        if rest == before {
            return rest;
        }
    }
}

fn identifier(text: &str) -> String {
    text.chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect()
}

fn parse_item(trimmed: &str, indent: usize, current_enum: Option<&str>) -> Option<Item> {
    if indent == 4
        && let Some(parent) = current_enum
        && trimmed
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_uppercase())
    {
        return Some(Item {
            kind: ItemKind::Variant,
            name: identifier(trimmed),
            parent: Some(parent.to_owned()),
        });
    }
    let rest = strip_visibility(trimmed);
    for (keyword, kind) in [
        ("fn ", ItemKind::Function),
        ("struct ", ItemKind::Type),
        ("enum ", ItemKind::Type),
        ("trait ", ItemKind::Trait),
        ("type ", ItemKind::Type),
        ("const ", ItemKind::Constant),
        ("static ", ItemKind::Constant),
    ] {
        if let Some(after) = rest.strip_prefix(keyword) {
            let name = identifier(after);
            if name.is_empty() {
                return None;
            }
            return Some(Item {
                kind,
                name,
                parent: None,
            });
        }
    }
    None
}

/// `enum` の要素 `lines[start]` の、波括弧の中の項目名（タプル・単位の要素は空）。
fn variant_fields(lines: &[&str], start: usize) -> Vec<String> {
    let mut body = String::new();
    let mut depth = 0_i32;
    let mut opened = false;
    for line in lines.iter().skip(start) {
        let trimmed = line.trim();
        if trimmed.starts_with("//") {
            continue;
        }
        for c in trimmed.chars() {
            match c {
                '{' => {
                    depth += 1;
                    opened = true;
                }
                '}' => depth -= 1,
                _ => {}
            }
        }
        body.push_str(trimmed);
        body.push(' ');
        if !opened || depth <= 0 {
            break;
        }
    }
    let Some(open) = body.find('{') else {
        return Vec::new();
    };
    let Some(close) = body.rfind('}') else {
        return Vec::new();
    };
    let Some(inner) = body.get(open + 1..close) else {
        return Vec::new();
    };
    split_top_level(inner)
        .into_iter()
        .filter_map(|segment| {
            let (name, _) = segment.split_once(':')?;
            let name = name.trim();
            (!name.is_empty()).then(|| name.to_owned())
        })
        .collect()
}

fn split_top_level(text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0_i32;
    let mut current = String::new();
    for c in text.chars() {
        match c {
            '<' | '(' | '[' | '{' => {
                depth += 1;
                current.push(c);
            }
            '>' | ')' | ']' | '}' => {
                depth -= 1;
                current.push(c);
            }
            ',' if depth == 0 => {
                parts.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    if !current.trim().is_empty() {
        parts.push(current);
    }
    parts
}

/// クレートの根（`apps/beer-game-rust`）の下の、`crates/*/src` を走査する。`livingdoc` 自身は除く。
///
/// # Errors
/// ファイルの読み取りの失敗、注釈の不正。
pub fn scan_workspace(root: &Path) -> Result<Scan, Error> {
    let mut scan = Scan::default();
    let mut crates: Vec<PathBuf> = read_dir_sorted(&root.join("crates"))?;
    crates.retain(|path| path.is_dir() && path.file_name().is_some_and(|n| n != "livingdoc"));
    for crate_dir in crates {
        let mut files = Vec::new();
        collect_rs(&crate_dir.join("src"), &mut files)?;
        for file in files {
            let text = fs::read_to_string(&file)
                .map_err(|e| Error::new(format!("{}: 読み取れない: {e}", file.display())))?;
            let relative = file
                .strip_prefix(root)
                .map_err(|e| Error::new(format!("{}: {e}", file.display())))?;
            let label = format!(
                "apps/beer-game-rust/{}",
                relative.to_string_lossy().replace('\\', "/")
            );
            let part = scan_source(&label, &text)?;
            scan.tags.extend(part.tags);
            scan.variants.extend(part.variants);
        }
    }
    Ok(scan)
}

fn read_dir_sorted(dir: &Path) -> Result<Vec<PathBuf>, Error> {
    let entries = fs::read_dir(dir)
        .map_err(|e| Error::new(format!("{}: 読み取れない: {e}", dir.display())))?;
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    paths.sort();
    Ok(paths)
}

fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), Error> {
    if !dir.is_dir() {
        return Ok(());
    }
    for path in read_dir_sorted(dir)? {
        if path.is_dir() {
            collect_rs(&path, out)?;
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
    Ok(())
}
