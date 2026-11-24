//! `sqlx::migrate!` はマイグレーションのファイルをコンパイル時に埋め込むが、cargo はその変更を追跡しない。
//! ディレクトリの変更で再ビルドさせる（これが無いと、古い埋め込みのまま古いスキーマで動く）。

use std::io::Write;

fn main() {
    drop(writeln!(
        std::io::stdout(),
        "cargo:rerun-if-changed=migrations"
    ));
}
