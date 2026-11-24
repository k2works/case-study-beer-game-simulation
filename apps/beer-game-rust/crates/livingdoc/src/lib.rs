//! Living Documentation の生成（ADR-002）。
//!
//! コードの doc コメントの注釈（`/// @term` など）とソースの走査から、
//! `docs/design/beer-game-rust/generated/` の文書を作る。標準ライブラリだけに依存する。
//!
//! | 注釈 | 形 | 生成物 |
//! | :--- | :--- | :--- |
//! | `@event` | `ID \| 発生する条件 [\| 設計書での名前]` | イベント一覧 |
//! | `@term` | `用語 \| 定義 \| 出典` | 用語集 |
//! | `@core` | `コンテキスト \| なぜ核心か` | コアのハイライト |
//! | `@tour` | `ツアー 順位 区分 \| 説明 [\| 補足の行…]` | ガイドツアー |
//! | `@landmark` | `地図 区分 \| 説明` | サイトシーイング・マップ |

use std::fmt;
use std::fs;
use std::path::Path;

pub mod render;
pub mod scan;

/// 生成の失敗（注釈の不正、コードと設計書の不一致、読み取りの失敗）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error(String);

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

/// 生成した 1 つの文書。`path` は、リポジトリの根からの相対パス。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Generated {
    pub path: String,
    pub content: String,
}

/// 生成物を置くディレクトリ（リポジトリの根から）。
pub const OUTPUT_DIR: &str = "docs/design/beer-game-rust/generated";

fn read(path: &Path) -> Result<String, Error> {
    fs::read_to_string(path)
        .map_err(|e| Error::new(format!("{}: 読み取れない: {e}", path.display())))
}

/// リポジトリの根から、すべての生成物を作る（書き込みはしない）。
///
/// # Errors
/// 注釈の不正、コードと設計書の不一致、読み取りの失敗。
pub fn generate(repo_root: &Path) -> Result<Vec<Generated>, Error> {
    let app = repo_root.join("apps/beer-game-rust");
    let scan = scan::scan_workspace(&app)?;
    let inputs = render::Inputs {
        projection_source: read(&app.join("crates/adapter-persistence/src/projection.rs"))?,
        kotlin_domain_model: read(&repo_root.join("docs/design/beer-game-kotlin/domain-model.md"))?,
        rust_domain_model: read(&repo_root.join("docs/design/beer-game-rust/domain-model.md"))?,
        crate_manifests: render::LAYERS
            .iter()
            .map(|layer| {
                read(&app.join(format!("crates/{layer}/Cargo.toml")))
                    .map(|text| ((*layer).to_owned(), text))
            })
            .collect::<Result<Vec<_>, Error>>()?,
    };
    render::render_all(&scan, &inputs)
}

/// 生成物をファイルへ書く。
///
/// # Errors
/// 書き込みの失敗。
pub fn write_all(repo_root: &Path, documents: &[Generated]) -> Result<(), Error> {
    for document in documents {
        let path = repo_root.join(&document.path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| Error::new(format!("{}: 作れない: {e}", parent.display())))?;
        }
        fs::write(&path, &document.content)
            .map_err(|e| Error::new(format!("{}: 書けない: {e}", path.display())))?;
    }
    Ok(())
}

/// コミット済みの文書との差を、パスの一覧で返す（空なら一致）。
#[must_use]
pub fn stale_documents(repo_root: &Path, documents: &[Generated]) -> Vec<String> {
    documents
        .iter()
        .filter(|document| {
            fs::read_to_string(repo_root.join(&document.path))
                .map_or(true, |committed| committed != document.content)
        })
        .map(|document| document.path.clone())
        .collect()
}
