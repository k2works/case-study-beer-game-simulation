// 理由: RT1 の命名（承認済み）の `__` を使うため（simulate_week_golden.rs と同じ）。
#![allow(non_snake_case)]

//! Game・Session 集約の Given（過去のイベント）/ When（コマンド）/ Then（イベントまたはエラー）のテスト。

mod fixtures;
mod game;
mod property;
mod replace_role;
mod session;
mod start_game;
