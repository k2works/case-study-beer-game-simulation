//! 結果の出力（CSV・JSON。US4.3）。要求時に、`week_role_results` と設定から作る純粋な関数。
//! CSV は RFC 4180（CRLF）。文字列の列の先頭が `=`・`+`・`-`・`@`・タブ・CR のときは、先頭に `'` を付ける（表計算の数式として解釈させない）。
//! 表示名・資格・参加コードは含めない（NF-S14）。数量と費用は、CSV と JSON で同じ値（同じ記録から作る。AC4.3.2）。

use sha2::{Digest, Sha256};

use crate::ResultRow;

/// 出力の形の版。CSV の各行の `schema_version`、JSON の `schemaVersion`、`X-Export-Schema-Version` に記録する。
pub const EXPORT_SCHEMA_VERSION: &str = "beer-game-kotlin.export.v1";

const CSV_HEADER: &str = "schema_version,game_id,settings_kind,settings_changes,commit_mode,week,role,orders,shipped,ordered,ending_inventory,ending_backlog,weekly_cost_minor,cumulative_cost_minor";

/// 出力の元。`results` は、週の昇順・役割は上流から下流の順。
#[derive(Clone, Copy, Debug)]
pub struct ExportInput<'a> {
    /// ゲームの ID（UUID の文字列）。
    pub game_id: &'a str,
    pub final_week: i64,
    /// `KIT`・`CUSTOM`。
    pub settings_kind: &'a str,
    /// キットの値から変えた項目（`INITIAL_INVENTORY` など）。
    pub changes: &'a [String],
    /// `MANUAL`・`AUTO`。
    pub commit_mode: &'a str,
    pub results: &'a [ResultRow],
}

fn role_text(row: &ResultRow) -> &'static str {
    match row.role {
        beergame_domain::Role::Factory => "FACTORY",
        beergame_domain::Role::Distributor => "DISTRIBUTOR",
        beergame_domain::Role::Wholesaler => "WHOLESALER",
        beergame_domain::Role::Retailer => "RETAILER",
    }
}

/// CSV の 1 つの文字列の列。数式として解釈される先頭の文字に `'` を付け、`,`・`"`・改行を含むなら引用する。
fn csv_cell(value: &str) -> String {
    let guarded = if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    if guarded.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", guarded.replace('"', "\"\""))
    } else {
        guarded
    }
}

/// CSV（見出し + 1 週 × 1 役割ごとの行。CRLF）。
#[must_use]
pub fn build_csv(input: &ExportInput<'_>) -> String {
    let mut out = String::from(CSV_HEADER);
    out.push_str("\r\n");
    let changes = input.changes.join(";");
    for row in input.results {
        out.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{},{},{},{}\r\n",
            csv_cell(EXPORT_SCHEMA_VERSION),
            csv_cell(input.game_id),
            csv_cell(input.settings_kind),
            csv_cell(&changes),
            csv_cell(input.commit_mode),
            row.week,
            csv_cell(role_text(row)),
            row.orders,
            row.shipment,
            row.order,
            row.inventory,
            row.backlog,
            row.cost,
            row.cumulative_cost,
        ));
    }
    out
}

/// JSON（`ExportDocument`）。文字列は、固定の列挙・UUID だけなので、エスケープは要らない。
#[must_use]
pub fn build_json(input: &ExportInput<'_>) -> String {
    let changes = input
        .changes
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(",");
    let records = input
        .results
        .iter()
        .map(|row| {
            format!(
                "{{\"week\":{},\"role\":\"{}\",\"orders\":{},\"shipped\":{},\"ordered\":{},\"endingInventory\":{},\"endingBacklog\":{},\"weeklyCostMinor\":{},\"cumulativeCostMinor\":{}}}",
                row.week,
                role_text(row),
                row.orders,
                row.shipment,
                row.order,
                row.inventory,
                row.backlog,
                row.cost,
                row.cumulative_cost,
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"schemaVersion\":\"{EXPORT_SCHEMA_VERSION}\",\"gameId\":\"{}\",\"finalWeek\":{},\"settings\":{{\"kind\":\"{}\",\"changes\":[{changes}],\"commitMode\":\"{}\"}},\"records\":[{records}]}}",
        input.game_id, input.final_week, input.settings_kind, input.commit_mode,
    )
}

/// 本文（UTF-8 のバイト列）の SHA-256。`sha256-` と小文字の 16 進。形式ごとに別の値になる。
#[must_use]
pub fn checksum(body: &str) -> String {
    let digest = Sha256::digest(body.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256-{hex}")
}
