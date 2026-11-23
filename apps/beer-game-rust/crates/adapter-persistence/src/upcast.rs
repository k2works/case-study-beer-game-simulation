//! イベントのスキーマ進化（ADR-006）。旧版（`schema_version`）のペイロードを、現行版へ変換する純粋関数の列。
//! 読み込み時に、`decode` の前に適用する。**イベントは書き換えない**（形の変更は、版とアップキャストで吸収する）。
//!
//! 2 段階リリース: まず「新しい版を読める」コードを配り（N-1 が新版のイベントを読める）、次の版で「新しい版を書く」。
//! 現行より新しい版は、読めないとして拒む（古いコードが、新しいイベントを黙って誤読しない）。

use serde_json::Value;

/// イベントの現行のスキーマの版。書くときの版（`encode`）と、これより新しい版を読めないことの基準。
pub const CURRENT_SCHEMA_VERSION: i32 = 1;

/// `from` 版のペイロードを `from + 1` 版へ変換する 1 段。`event_type` ごとに、必要なものだけ変える。
pub type Step = fn(event_type: &str, payload: Value) -> Value;

/// 版ごとの変換の列。現行の版は 1 なので、まだ変換は無い。版を上げるときに、`(旧版, 変換)` を足す。
pub const STEPS: &[(i32, Step)] = &[];

/// ペイロードを現行の版へ変換する。
///
/// # Errors
/// 版が 1 未満、または現行より新しいとき。
pub fn upcast(event_type: &str, schema_version: i32, payload: Value) -> Result<Value, String> {
    upcast_with(
        STEPS,
        CURRENT_SCHEMA_VERSION,
        event_type,
        schema_version,
        payload,
    )
}

/// 変換の列と現行の版を指定して変換する（試験が、旧版を作って確かめるため）。
///
/// # Errors
/// 版が 1 未満、現行より新しい、または途中の変換が足りないとき。
pub fn upcast_with(
    steps: &[(i32, Step)],
    current: i32,
    event_type: &str,
    schema_version: i32,
    payload: Value,
) -> Result<Value, String> {
    if schema_version < 1 {
        return Err(format!("不正なスキーマの版: {schema_version}"));
    }
    if schema_version > current {
        return Err(format!(
            "読めない新しいスキーマの版: {schema_version}（現行 {current}。{event_type}）。先に、新しい版を読めるコードを配る"
        ));
    }
    let mut payload = payload;
    for version in schema_version..current {
        let (_, step) = steps
            .iter()
            .find(|(from, _)| *from == version)
            .ok_or_else(|| {
                format!(
                    "版 {version} から {} への変換が無い（{event_type}）",
                    version + 1
                )
            })?;
        payload = step(event_type, payload);
    }
    Ok(payload)
}

#[cfg(test)]
#[allow(non_snake_case)] // 理由: RT1 の命名（承認済み）の `__` を使うため。
mod tests {
    use super::*;
    use serde_json::json;

    /// v1 → v2: 項目 `n` を `count` に改名する。
    fn rename_n(_: &str, mut payload: Value) -> Value {
        if let Some(n) = payload.get("n").cloned() {
            payload["count"] = n;
            if let Some(object) = payload.as_object_mut() {
                object.remove("n");
            }
        }
        payload
    }

    /// v2 → v3: 項目 `unit` を既定値で足す。
    fn add_unit(_: &str, mut payload: Value) -> Value {
        payload["unit"] = json!("piece");
        payload
    }

    const CHAIN: &[(i32, Step)] = &[(1, rename_n), (2, add_unit)];

    #[test]
    fn nf_r15__現行の版のペイロードは変えない() -> Result<(), String> {
        let payload = json!({"count": 3, "unit": "piece"});
        assert_eq!(upcast_with(CHAIN, 3, "X", 3, payload.clone())?, payload);
        Ok(())
    }

    #[test]
    fn nf_r15__旧版のペイロードは_版の順に変換して現行にする() -> Result<(), String> {
        let upcasted = upcast_with(CHAIN, 3, "X", 1, json!({"n": 3}))?;
        assert_eq!(upcasted, json!({"count": 3, "unit": "piece"}));
        let from_v2 = upcast_with(CHAIN, 3, "X", 2, json!({"count": 3}))?;
        assert_eq!(from_v2, json!({"count": 3, "unit": "piece"}));
        Ok(())
    }

    #[test]
    fn nf_r15__現行より新しい版は_読めないとして拒む() {
        let error = upcast_with(CHAIN, 3, "X", 4, json!({}));
        assert!(error.is_err_and(|e| e.contains("新しい")));
    }

    #[test]
    fn nf_r15__版が_1_未満なら拒む() {
        assert!(upcast_with(CHAIN, 3, "X", 0, json!({})).is_err());
    }

    #[test]
    fn nf_r15__途中の変換が足りなければ_黙って通さず拒む() {
        // v1 → v2 の変換が無いまま、現行が v3
        let steps: &[(i32, Step)] = &[(2, add_unit)];
        assert!(upcast_with(steps, 3, "X", 1, json!({"n": 3})).is_err());
    }

    #[test]
    fn nf_r15__いまの現行の版は_1_で_変換は空() -> Result<(), String> {
        assert_eq!(CURRENT_SCHEMA_VERSION, 1);
        assert!(STEPS.is_empty());
        let payload = json!({"a": 1});
        assert_eq!(upcast("GameCreated", 1, payload.clone())?, payload);
        Ok(())
    }
}
