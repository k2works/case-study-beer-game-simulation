// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! N-1 互換の読み取りの検査（NF-O11。運用の障害パターン）。**直前のリリースの読み取り側**（`EventCodec` と、そのアップキャスト）が、
//! **現在の版が書くイベント**を読めることを確かめる。旧イメージが新しいイベントを読めないと、ロールバックが効かなくなる
//! （読む版 → 書く版の 2 段階に反する変更を、リリース前に検出する）。
//!
//! `scripts/n1-compat.sh` が、このファイルを直前のリリースの作業ツリーへ複写し、`N1_GOLDEN_FILES` に現在の golden
//! （`tests/codec.rs` が `GOLDEN_EXPORT` で書き出す）を渡して実行する。**公開の入口（`EventCodec::decode`）だけを使う**こと
//! （旧版にも同じ入口があるため）。環境変数が無いときは、何も検査せずに通る（通常の `cargo test` では動かさない）。

use beergame_adapter_persistence::{EventCodec, GameCodec, SessionCodec};
use serde_json::Value;

#[test]
fn nf_o11__現在の版が書くイベントを_この版の読み取り側がすべて読める() -> Result<(), String> {
    let Some(files) = std::env::var_os("N1_GOLDEN_FILES") else {
        return Ok(());
    };
    let files = files.to_string_lossy().into_owned();
    let mut read = 0_usize;
    for file in files.split(',').filter(|f| !f.is_empty()) {
        let text = std::fs::read_to_string(file).map_err(|e| format!("{file}: {e}"))?;
        let entries: Vec<Value> =
            serde_json::from_str(&text).map_err(|e| format!("{file}: {e}"))?;
        for entry in &entries {
            let field = |name: &str| {
                entry
                    .get(name)
                    .ok_or_else(|| format!("{file}: {name} が無い"))
            };
            let stream = field("stream")?.as_str().unwrap_or_default();
            let event_type = field("event_type")?.as_str().unwrap_or_default();
            let version =
                i32::try_from(field("schema_version")?.as_i64().unwrap_or(0)).unwrap_or(0);
            let payload = field("payload")?.clone();
            let result = match stream {
                "GAME" => GameCodec.decode(event_type, version, payload).map(|_| ()),
                "SESSION" => SessionCodec
                    .decode(event_type, version, payload)
                    .map(|_| ()),
                other => Err(format!("不明なストリーム: {other}")),
            };
            result.map_err(|e| format!("{stream}/{event_type} (v{version}) を読めない: {e}"))?;
            read += 1;
        }
    }
    if read == 0 {
        return Err("golden にイベントが無い（検査が空）".to_owned());
    }
    Ok(())
}
