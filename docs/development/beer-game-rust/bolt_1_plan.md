---
type: Plan
title: "Bolt 1 計画 - 検証と土台（Rust 版）"
description: "beer-game-rust の Bolt 1 のステップ計画。ゴール、仮説、対象の受入条件、着手前に人の判断が要る項目、TDD のステップと承認ゲート、完了条件。人の承認待ち。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-21T03:36:11Z }
---

# Bolt 1 計画 - 検証と土台（Rust 版）

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B1（[リリース計画](./release_plan.md)）。Unit U1（ゴール: U1 の B1〜B4 を順に進める） |
| 所要（計画） | 4 稼働日（2026-11-24〜2026-11-27。仮定） |
| ゲート密度 | **密**（ステップごとに、人が検証する） |
| アプローチ | **B1 はドメインの核から**（[開発戦略](./development_strategy.md) の序盤の例外）。DB を要さない未確認の前提を、最小のコードで確かめる |
| テスト戦略 | Comprehensive（`simulate_week`、集約の `decide`/`evolve`）、Standard（その他） |
| 準拠するガイド | **[関数型プログラミングガイド（Rust 編）](../../reference/関数型プログラミングガイド_Rust編.md)**（[開発戦略](./development_strategy.md) の「準拠」の節）。全ステップで、該当章を参照し、人が準拠を検証する |
| 状態 | **着手前の判断項目 1〜6 は 2026-11-21 にユーザーが「案どおり」承認した**（7 は B1 で導入しないことの確認）。計画全体の `verified` は未記録。**Step 1〜9 は実施済み。ゲートは人の検証待ち（結果は [Bolt 1 終了報告](./bolt_1_report.md)）** |

### ゴール

①Cargo ワークスペースと最小の CI の土台を作る。②**ドメインの核**（値オブジェクト、`simulate_week`、Game・Session の `decide`/`evolve`、`start_game`）を、Given/When/Then で作る。③[テスト戦略](../../design/beer-game-rust/test-strategy.md) の B1 の受入条件の表のうち、**DB を要さない前提**（clippy の lint、cucumber-rs の日本語 Gherkin と Undefined の扱い、proptest、cargo-llvm-cov）と、守り DS-1〜6・14 を、**「成立／不成立」の記録つき**で確かめる。

### 確認したい仮説

1. 設計の型・純粋性の規約（newtype、`Evolution`、`unwrap` 禁止など）は、Rust で成り立つか（clippy の lint で守れるか）。
2. clippy の `wildcard_enum_match_arm` は、`evolve` の最後の腕の `_` と衝突するか。許容する規則を、設定または ADR に書けるか。
3. cucumber-rs は日本語 Gherkin（`# language: ja`）を実行でき、**ステップ定義がないシナリオを失敗にできる**か。
4. proptest で、`evolve` の腕を 1 つ消すと性質テストが落ちるか。
5. `cargo llvm-cov` で、行 80%（domain 100%）を割ると終了コードが非 0 になるか。
6. AI の出力の質は、どの密度の承認ゲートが要るか（以降の Bolt の密度を決める）。

### 対象の受入条件

B1 のドメインの核で扱うもの（HTTP・DB は B2）。共有する `features/` のうち、**ドメインの純粋関数で表せるシナリオ**に限る。

| ストーリー | 受入条件 | 備考 |
| :--- | :--- | :--- |
| US1.1 | AC1.1.1、AC1.1.2 | キット準拠の作成。無効な需要系列は、対象週と修正内容を示す（誤りは項目ごとに集める） |
| US1.2 | AC1.2.1、AC1.2.2、AC1.2.3（ドメインの判定） | 1 役割 1 人。受付終了の拒否 |
| US2.2 | AC2.2.1、AC2.2.2 | 数量の保存と検証 |
| US2.3 | AC2.3.1〜AC2.3.5（`simulate_week` と `decide` の範囲） | 手動の確定、一回性、決定論、役割別の週結果 |

### 範囲外（後続の Bolt）

イベントストア・投影・axum・DB（B2）。契約テスト・許可リストの運用・CI のゲートの完成・git/Claude の hook（B3）。コンテナ（B4）。振り返り（B5）。

---

## 人の判断が要る項目（着手前の承認）

| # | 項目 | 案 | 備考 |
| :--- | :--- | :--- | :--- |
| 1 | **新規依存関係**（クレート） | 実行時: `thiserror` 2.0.21（domain）。開発時のみ: `proptest` 1.12.0、`cucumber` 0.23.0、`tokio` 1.54.1（cucumber の実行用。`rt`・`macros` のみ）。版は [技術スタック](../../design/beer-game-rust/tech-stack.md) の確認値（`cargo search`、2026-11-19）。**導入の直前に、再度 `cargo search` と公式情報で確認する** | domain の依存に `tokio`・`sqlx` を含めない（R4） |
| 2 | **開発ツール**の版 | `cargo-llvm-cov`・`cargo-deny` は手元に**古い版**がある（0.8.7、0.19.9。設計は 0.9.1、0.21.0）。**設計の版へ更新するか、手元の版で確かめるか** | 版の違いで挙動が変わりうる。更新は `cargo install`（ネットワーク） |
| 3 | **ディレクトリの新設** | `apps/beer-game-rust/`（`Cargo.toml`、`rust-toolchain.toml`（1.97.1、edition 2024）、`crates/domain`、`guards/`）。**`features/` は Kotlin 版のものを読み取り専用で参照**（RF1。変更しない） | 共有物の参照の方法（相対パス）を B1 で確定 |
| 4 | **CI のワークフローの新設** | `.github/workflows/beer-game-rust.yml`（fmt・clippy・test・llvm-cov・deny のみ。`apps/beer-game-rust/**` の変更で起動）。**デプロイはしない** | 新規の CI ファイル。他のワークフローは変更しない |
| 5 | **RT1 の命名規則** | 接頭辞は AC の ID だけ（`ac2_4_1__…`）。複数は `ac2_4_1_ac2_4_2__…`。US のみは `us2_4__…` | test-strategy の未決 17 |
| 6 | **lint の規則**（`wildcard_enum_match_arm` と `evolve` の `_`） | 「`_` を使わない」を状態・エラー・イベントの変換に当てはめ、**`evolve_*` の最後の 1 腕だけ例外**。例外の理由は設定または ADR に記録 | B1 の仮説 2。結果で ADR を起こす |
| 7 | **守りの hook・CI の必須化** | **B1 では導入しない**（B3）。B1 は DS-1〜6・14 を、コンパイラ・lint・テスト・最小 CI で | 開発戦略の未決事項 7・8 は B3 の前に承認を求める |

**範囲に含めないことの確認**: `.claude/settings.json` の変更、git の hook、ブランチ保護、AWS への適用は、B1 で行いません。

---

## 静的解析とルール設定（ガイド第 9 章の適用）

[関数型プログラミングガイド（Rust 編）](../../reference/関数型プログラミングガイド_Rust編.md) の第 9 章「静的解析とルール設定」を、B1 で次のとおり適用します。**Rust 版にはガイド 9.1 のとおり detekt・ktlint・PMD を入れません**（Rust のソースは対象外。PMD は重複検出のみ）。

| ガイドの節 | B1 での適用 | 確認する Step |
| :--- | :--- | :--- |
| 9.1 ツールの選び方 | **rustc（`[lints.rust]`）、rustfmt、clippy、カバレッジ**の 4 つ。それぞれの役割を CI の段に対応させる | Step 1・8 |
| 9.2 検査に何を入れるか | **段ごとに「何を守るか」「`test` と重複するか」「秒数」を書き出してから入れる**（`fmt`・`clippy`・`test`・`cov`・`deny`）。重複する段は入れない。結果を Bolt 終了報告の表に記録 | Step 1・8・9 |
| 9.3 clippy が止めたものの扱い | **`allow` するときは理由を残す**（コメントまたは ADR）。指摘を「設計の改善」と「clippy の好み」に仕分けて件数を記録。法則のテストが止められる場合のみ `allow` | Step 4〜6 |
| 9.4 コンパイラと clippy が守る範囲 | **守られない範囲をテストで確かめる**: 組（タプル）の `match` のワイルドカード、遷移の行き先の誤り、クエリ側からの状態変更。`evolve` の腕を消す性質テスト（DS-5）と遷移表のテスト | Step 2・5・6 |
| 9.5 ツールを入れる前に、守りたいことを決める | 複数人・長期の保守に当たるため、**clippy の lint を `deny` にして CI で止める。`[workspace.lints]` で全クレートに揃え、層ごとに `clippy.toml` を分ける**。入れる前に、守る規約と副作用（ビルド時間）を記録 | Step 1 |
| 9.6 関数型ルールを clippy の設定にする | **章と規約の対応表（ガイド 9.6）を、そのまま `Cargo.toml` の `[lints]` と `clippy.toml` にする**。確認用コード（17 件）を fixture にし、**Rust 1.97.1 の clippy で期待どおりの行が報告される**ことを確かめる（ガイドは clippy 0.1.91） | Step 1・2 |

**ルールそのものをテストファーストで確かめる**: 設定を入れる前に、fixture（違反するコードとしないコード）を置き、**違反だけが報告され、しないコードは報告されない**ことを確認してから、設定を `deny` にして CI に入れます。ガイドとの差分（Rust 版で変えた設定）は、理由とともに ADR か設計書に記録します。

---

## ステップ計画

記号: 🔵 土台・検証、🔴 Red、🟢 Green、🟡 Refactor、✅ 検証。各ステップの終わりが**承認ゲート**です（密）。1 ステップ 1 コミット（構造と動作を分ける）。

### Step 1: リポジトリの土台（🔵）

- `apps/beer-game-rust/` に、ワークスペース、`rust-toolchain.toml`（1.97.1）、`crates/domain`、`[workspace.lints]`（**[関数型プログラミングガイド（Rust 編）](../../reference/関数型プログラミングガイド_Rust編.md) 9.6 の設定を出発点**: `unsafe_code`・`unused_must_use`、`unwrap_used`・`expect_used`・`panic`・`todo`・`indexing_slicing`・`wildcard_enum_match_arm`・`match_wildcard_for_single_variants`・`print_stdout`・`print_stderr`・`dbg_macro`・`let_underscore_must_use`・`disallowed_methods`・`disallowed_types` を deny）、**層ごとの `clippy.toml`**（domain は厳格: `SystemTime::now`・`Instant::now`・`thread::sleep`・`thread::spawn`・`catch_unwind`・`env::var`・`std::sync::Mutex` を禁止。ルートはテストの許可のみ。ガイド 9.5）、`deny.toml` の最小。
- 最小の CI（fmt・clippy・test・deny）。**この時点で緑**。
- **ゲート**: 構成と lint の設定を人が検証。

### Step 2: 守りの fixture（DS-1〜3、🔴🟢）

- `guards/fixtures/` に、**規則を破る最小のコード**（ガイド 9.6 の確認用コードを出発点に、`unsafe`、`unwrap`、`expect`、`panic`、`todo`、`println`・`dbg`、`SystemTime::now`、`Mutex`、添字アクセス、ワイルドカード）を、ワークスペースの外に置き、**テストが `cargo clippy` を実行して失敗を期待する**。違反を消すと緑になることも確認。
- **ガイドの 17 件が、Rust 1.97.1 の clippy でも期待どおりの行で報告されるか**を確かめて記録する（ガイドは clippy 0.1.91 で確認）。**組（タプル）の `match` のワイルドカードは lint で発火しない**（ガイド 9.4）ことも、fixture で確認して記録する。
- **ゲート**: 各 fixture が**期待の理由で**落ちることを、人が出力で確認。

### Step 3: アーキテクチャテスト（DS-4、🔴🟢）

- `cargo metadata` で、domain の依存に `tokio`・`sqlx` など許可しないものが**ない**ことを検査するテスト。許可しない依存を足すと落ちることを確認。
- **ゲート**。

### Step 4: ドメイン — 値オブジェクトと `simulate_week`（🔴🟢🟡）

- 値（`Role`、`Quantity`、`Week`、`Money`、`DisplayName` など。newtype）と `simulate_week`（12 ステップ。Kotlin 版を正本）。**既知系列の golden**と、proptest の性質（決定論、保存則）。誤りを項目ごとに集める関数は自前。
- **共有の土台（型）を最初に作るスライドでは、後続の振る舞いのテストも先に書いて失敗を確かめる**（プロジェクトの規約）。
- **ゲート**: 全行理解。golden の値を人が確認。

### Step 5: ドメイン — Game（🔴🟢🟡）

- `decide_game`/`evolve_game`、`Evolution::{Applied, Ignored}`（RD2）。作成・参加・割り当て・開始前の検証（AC1.1.*、AC1.2.*）。Given/When/Then。
- **性質テスト**: `evolve` の腕を 1 つ消すと落ちること（DS-5。仮説 4）。
- **ゲート**。

### Step 6: ドメイン — Session と `start_game`（🔴🟢🟡）

- `decide_session`/`evolve_session`、`start_game`（2 ストリームへの追記の**イベントの組**を返す純粋関数）、`SaveDecision`・`CommitWeek`（AC2.2.*、AC2.3.*）。
- **ゲート**。

### Step 7: cucumber-rs の日本語 Gherkin の検証（🔵🔴）

- 開発用のクレート（B2 の `acceptance` に移す前提の検証）で、共有する `features/` の**ドメインで表せる 1 本**を、`# language: ja` で実行する。**ステップ定義がないとき、Undefined が失敗になり終了コードが非 0** になる設定を確認。JSON または JUnit の出力を確認。
- **不成立なら**: キーワードを英語にして本文を日本語にする代替、または別の方式を比較し、**人に提示**（設計判断 R5 の見直し）。
- **ゲート**。

### Step 8: カバレッジのゲートと記録（🟢✅）

- `cargo llvm-cov` で行 80%（domain 100%）を割ると失敗する設定（DS-6）。CI に追加。**しきい値を 1 件割る fixture で落ちることを確認**。分岐の計測の可否を記録（RT3）。
- **B1 の受入条件の表（DB を要さない行）を、成立・不成立で記録**。不成立の行は、見直す対象と案を書く。
- **ゲート**。

### Step 9: 検証と終了（✅）

- 品質チェック一式（fmt・clippy・test・llvm-cov・deny）が緑。`validating-design`（設計書との整合）。実装で変わった設計判断を、設計書・ADR に反映（**設計書の内容を変えたときは、`verified` の再確認を人に求める**）。
- Bolt 終了報告（`bolt_1_report.md`）に、前提の成否、人による実操作の確認、所要の実績（人の検証時間を含む）を記録。B2 の計画に反映。
- **ゲート**: Bolt 1 の完了の承認。

---

## 完了条件（Definition of Done）

- [ ] 判断項目 1〜6 が承認され、使った版が出典つきで記録されている
- [ ] ドメインの Given/When/Then（Game・Session・`simulate_week`）が green。golden と性質テストが green。**domain の行カバレッジ 100%**
- [ ] DS-1〜3 の fixture が、**期待の理由で落ちる**（ローカルと GitHub Actions）
- [ ] **ガイド第 9 章の適用**（上の表）: 段ごとの「守るもの・重複・秒数」の記録、ガイド 9.6 の設定、確認用コード（17 件）が Rust 1.97.1 の clippy で期待どおり、`allow` はすべて理由つき、守られない範囲（組の `match` など）をテストで確認
- [ ] DS-4（依存方向）、DS-5（腕を消すと落ちる）、DS-6（しきい値）、DS-14（`cargo deny`）が確認済み
- [ ] cucumber-rs の日本語 Gherkin の可否と Undefined の扱いが記録されている
- [ ] 品質チェック一式が CI で緑
- [ ] 設計書・ADR が実装と一致している。B1 の受入条件の表（DB を要さない行）が記録済み

### デモ項目

1. ドメインのテスト（作成 → 参加 → 割り当て → 開始 → 入力 → 確定）が通る。
2. 規則を破る fixture が、規則ごとに失敗する。
3. 共有する `features/` の 1 本が、日本語 Gherkin で実行され、ステップ定義を消すと失敗する。

## リスクと対策

| リスク | 対策 |
| :--- | :--- |
| lint が `evolve` の `_` と衝突する | 例外の規則を設定・ADR に記録（判断項目 6） |
| cucumber-rs が日本語を扱えない | 代替（英語キーワード + 日本語本文）を比較して人に提示 |
| ガイドの設定が Rust 1.97.1 の clippy で件数・行が変わる | 確認用コードで差を記録し、設定を調整して ADR に残す |
| 手元の `cargo-llvm-cov`・`cargo-deny` が古い | 判断項目 2。版を記録 |
| `simulate_week` の golden が Kotlin 版と食い違う | Kotlin 版のテストを正本にし、差は ADR で記録 |
| 承認待ちで進行が止まる | 判断項目 1〜6 を最初にまとめて確認 |

## 完了後の流れ

B2（縦の最小: イベントストア・axum・許可リスト・NF-P2 の実測）の計画を作成し、承認を受ける。

---

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-21 | 初版作成（人の承認待ち） | claude-code |
