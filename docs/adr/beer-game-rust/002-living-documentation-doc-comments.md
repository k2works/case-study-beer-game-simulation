---
type: ADR
title: "ADR-002: 用語集・イベント一覧・案内を、doc コメントの注釈とソースの走査から生成する"
description: "ADR-001 が「設計時に定める」とした、Kotlin 版 ADR-018 の Rust での実現。doc コメントの注釈（@event・@term・@core・@tour・@landmark）を標準ライブラリだけの小さなクレートが走査して文書を生成し、設計書・コミット済みの生成物との不一致を試験で失敗にする。人の承認待ち。"
tags: [adr]
status: stable
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-24T04:20:00Z }
verified:
  - { by: human:kakimomokuri, at: 2026-11-24T06:05:58Z }
---

# ADR-002: 用語集・イベント一覧・案内を、doc コメントの注釈とソースの走査から生成する

[ADR-001](./001-rust-version-of-beer-game-kotlin.md) は、beer-game-kotlin の ADR-018（型の注釈から用語集・イベント一覧を生成する）を「置き換える」とし、方針（型から生成し、不一致を CI で落とす）と 4 つの検査は引き継ぎ、実現（属性マクロ、doc コメントなど）は設計時に定めるとした。本書は、その実現の案である。AI が提案し、2026-11-24 にユーザーが承認した。

日付: 2026-11-24

## ステータス

承認済み（2026-11-24、ユーザー）。実装は、承認の前に Living Documentation の適用として先に作った（`crates/livingdoc`）。

## コンテキスト

- 開発戦略は「手作業で更新する一覧は作らない。重複する知識は、不一致を検出するテストで守る」とする。Kotlin 版は、型の注釈（`@Term`・`@EventSpec`・`@CoreConcept`・`@KeyLandmark`・`@GuidedTour`）から文書を生成している。
- Rust 版の設計書は、イベントの一覧（EV-G01〜G12、EV-S01〜S10）を Kotlin 版の表に委ね、「名称も変えない」とするだけで、**コードとの一致を確かめる仕組みがなかった**。実際に突き合わせると、コードの doc コメントの EV 番号が Kotlin 版の表と違い（`ObserverInvited` が EV-G13。表では EV-G05）、名前も 1 つ違っていた（`RoleReplaced`。表では EV-S09 `RoleHolderReplaced`）。
- Rust にはユーザー定義の実行時の注釈がない。属性マクロは別クレートと `syn` などの依存を要する（ADR-001 の「新規の依存は導入時に承認を得る」）。

## 決定

- **注釈**: doc コメントの 1 行（`/// @種別 先頭 | 項目 | 項目`）。直後の要素（属性は飛ばす）に結び付く。種別は 5 つ。

  | 注釈 | 形 | 生成物 |
  | :--- | :--- | :--- |
  | `@event` | `ID \| 発生する条件 [\| 設計書での名前]` | イベント一覧 |
  | `@term` | `用語 \| 定義 \| 出典` | 用語集 |
  | `@core` | `コンテキスト \| なぜ核心か` | コアのハイライト |
  | `@tour` | `ツアー 順位 区分 \| 説明 [\| 補足の行…]` | ガイドツアー |
  | `@landmark` | `地図 区分 \| 説明` | サイトシーイング・マップ |

- **生成**: 新しいクレート `beergame-livingdoc`（標準ライブラリだけ。**外部の依存を足さない**）。`crates/*/src/**/*.rs` を走査する。イベントの項目は `enum` の宣言から、書き込む投影のテーブルは `adapter-persistence/src/projection.rs` の `match` の腕（と、腕が呼ぶ補助関数）の SQL から、層の依存は各 `Cargo.toml` の `[dependencies]` から導く。
- **出力**: `docs/design/beer-game-rust/generated/`（`events.md`・`glossary.md`・`core-highlight.md`・`walking-skeleton-tour.md`・`ddd-sightseeing-map.md`・`architecture-sightseeing-map.md`）。フロントマター以外を含め、手で編集しない。再生成は `just livingdoc`、検査だけは `just livingdoc-check`。
- **検査（`cargo test --workspace` に含まれ、CI で走る）**:
  1. 生成物が、コミット済みの文書と一致する（差があれば `just livingdoc` を促す）。
  2. `GameEvent`・`SessionEvent` の全要素に `@event` がある。ID の形（`EV-G` / `EV-S` と 2 桁）・重複を調べる。
  3. イベントの ID と名前が、beer-game-kotlin の設計書の表と一致する。意図した差は、注釈の 3 番目の項目に設計書での名前を書いて明示する（現在は EV-S09 の 1 件）。設計書にあって未実装のイベントは、一覧に載せる（失敗にしない）。
  4. `@core` は設計書の「中核」のコンテキストだけ、10 個以内。`@landmark` は地図ごとに 1〜10 個。ツアーの順位の重複・不正な順位・存在しないイベントの参照・未知の注釈は誤り。
- **付ける範囲**: これから書くコードと、案内に要る少数だけに付ける（既存コードへの一括適用はしない）。

## 影響

### ポジティブ

- イベントの ID・名前・ストリーム・項目・投影が、コードから生成され、設計書の表との不一致が CI で落ちる。実装と設計書のずれ（EV-G13・RoleReplaced）を、導入の時点で検出できた。
- 新しく参加する人の入口（コアのハイライト、ウォーキングスケルトンのツアー、2 つのマップ）が、改名や移動に追従する。
- 新しい依存がなく、`cargo deny` の対象は変わらない。

### ネガティブ・リスク

- **イベントの名前の差が残る**: `RoleReplaced` は永続化されたイベントの種別（`event_type`）で、改名は保存済みのイベントの読み出し（アップキャスト）を要するため、**コードを設計書に合わせて改名しない**。差は注釈で明示し、設計書の表を直すかは人の判断。
- 注釈は doc コメントなので、`cargo doc` の本文にも出る。
- 走査は `rustfmt` の書式（要素のインデントが 4、`match` の腕が 8）と、`projection.rs` の書き方に依存する。書き方を変えると、検査が失敗して気づける（黙って欠けない）。
- 「発生する条件」は注釈の手書きで、実装との一致は検査しない。
- 設計書だけの変更では、CI のパスフィルター（`apps/beer-game-rust/**`）に当たらず、突き合わせが走らない（`docs/design/beer-game-kotlin/domain-model.md` を変えたときなど）。パスフィルターの変更は人の判断。
- Kotlin 版にある CQRS・イベントソーシングのツアーは作っていない（仕組みは同じで、注釈と `TOURS` の定義を足せば作れる）。

## 代替案

| 案 | 内容 | 採らない理由 |
| :--- | :--- | :--- |
| B: 属性マクロ（`#[term(..)]`） | 手続きマクロのクレートと `syn`・`quote` で、型に付ける | 新しい依存とクレートが要る。コンパイル時にしか見えず、生成と突き合わせを別に作る必要がある |
| C: 別のツール（`syn` で構文木を読む） | 走査を正確にする | 依存が増える。現在の規模（5 クレート、注釈 58 行）では、行の走査で足りる |
| D: 手書きのまま | 設計書の表だけを正本にする | すでに EV 番号がずれていた。手作業の一覧は更新されなくなる |

## 未確認

- 用語の網羅（11 項目。新しく足す概念から付ける）。
- CQRS・イベントソーシングのツアー、模範例。
- 設計書の変更でも突き合わせが走るようにする CI のパスフィルターの変更。

## 参照

- [ADR-001](./001-rust-version-of-beer-game-kotlin.md)、[beer-game-kotlin の ADR-018](../beer-game-kotlin/018-living-documentation-annotations.md)
- [生成物](../../design/beer-game-rust/generated/events.md)、[Living Documentation 導入ガイド](../../reference/LivingDocumentation導入ガイド.md)
