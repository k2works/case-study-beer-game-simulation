// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 結果の出力（AC4.3.1・AC4.3.2）。CSV・JSON・チェックサムは純粋な関数。

use beergame_application::{ExportInput, ResultRow, build_csv, build_json, checksum};
use beergame_domain::Role;

fn rows() -> Vec<ResultRow> {
    [Role::Factory, Role::Retailer]
        .into_iter()
        .map(|role| ResultRow {
            role,
            week: 1,
            orders: 4,
            order: 5,
            inventory: 12,
            backlog: 0,
            shipment: 4,
            cost: 600,
            cumulative_cost: 600,
        })
        .collect()
}

#[test]
fn ac4_3_1__csv_は_見出しと_1_週_1_役割ごとの行を_crlf_で返す() {
    let results = rows();
    let changes = vec!["INITIAL_INVENTORY".to_owned(), "SHIPMENT_DELAY".to_owned()];
    let csv = build_csv(&ExportInput {
        game_id: "00000000-0000-0000-0000-000000000001",
        final_week: 1,
        settings_kind: "CUSTOM",
        changes: &changes,
        commit_mode: "MANUAL",
        results: &results,
    });
    let lines: Vec<&str> = csv.split("\r\n").collect();
    assert_eq!(lines.len(), 4, "見出し + 2 行 + 末尾の空");
    assert!(
        lines
            .first()
            .is_some_and(|h| h.starts_with("schema_version,game_id,"))
    );
    assert_eq!(
        lines.get(1),
        Some(
            &"beer-game-kotlin.export.v1,00000000-0000-0000-0000-000000000001,CUSTOM,INITIAL_INVENTORY;SHIPMENT_DELAY,MANUAL,1,FACTORY,4,4,5,12,0,600,600"
        )
    );
}

#[test]
fn ac4_3_2__json_は_csv_と同じ値で_スキーマ版と変更した項目を持つ() {
    let results = rows();
    let json = build_json(&ExportInput {
        game_id: "00000000-0000-0000-0000-000000000001",
        final_week: 1,
        settings_kind: "KIT",
        changes: &[],
        commit_mode: "AUTO",
        results: &results,
    });
    assert!(json.starts_with("{\"schemaVersion\":\"beer-game-kotlin.export.v1\""));
    assert!(
        json.contains("\"settings\":{\"kind\":\"KIT\",\"changes\":[],\"commitMode\":\"AUTO\"}")
    );
    assert!(json.contains("\"role\":\"RETAILER\",\"orders\":4,\"shipped\":4,\"ordered\":5"));
    assert!(json.contains("\"weeklyCostMinor\":600,\"cumulativeCostMinor\":600"));
}

#[test]
fn ac4_3_2__チェックサムは_sha256_の小文字の_16_進で_本文ごとに変わる() {
    // SHA-256("abc") の既知の値
    assert_eq!(
        checksum("abc"),
        "sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_ne!(checksum("a"), checksum("b"));
}

#[test]
fn ac4_3_1__csv_の文字列の列は_数式の先頭に引用符を付け_区切りを含めば引用する() {
    let results = Vec::new();
    let formula = vec!["=1+1".to_owned()];
    let csv = build_csv(&ExportInput {
        game_id: "+id",
        final_week: 1,
        settings_kind: "KIT",
        changes: &formula,
        commit_mode: "a,\"b\"",
        results: &results,
    });
    // 行は無いので、見出しだけ。引用は、行があるときに現れる
    assert_eq!(csv.matches("\r\n").count(), 1);
    let results = rows();
    let csv = build_csv(&ExportInput {
        game_id: "+id",
        final_week: 1,
        settings_kind: "\tKIT",
        changes: &formula,
        commit_mode: "a,\"b\"",
        results: &results,
    });
    let line = csv.split("\r\n").nth(1).unwrap_or_default();
    assert!(line.contains(",'+id,"), "{line}");
    assert!(line.contains(",'\tKIT,"), "{line}");
    assert!(line.contains(",'=1+1,"), "{line}");
    assert!(line.contains(",\"a,\"\"b\"\"\","), "{line}");
}
