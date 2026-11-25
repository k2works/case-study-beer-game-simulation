---
type: ADR
title: "ADR-001: beer-game-kotlin を Scala 版として作り、設計と ADR を流用する"
description: "beer-game2 の要件・ストーリー・Unit 定義と beer-game-kotlin の設計を正本として流用し、Scala 3（Cats Effect + http4s + doobie）と既存の React で作り直す。Intent・成功の測り方・範囲（U1〜U3 を約束）、beer-game-kotlin の ADR の引き継ぎ表（本文で検証済み）、Scala 固有の判断、関数型プログラミングガイド（Scala 編）の各章から設計書へのトレース表を含む。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-25T06:10:00Z }
---

# ADR-001: beer-game-kotlin を Scala 版として作り、設計と ADR を流用する

beer-game-kotlin と同じ機能と振る舞いを、Scala 3（Cats Effect + http4s + doobie）のバックエンドと既存の React のフロントエンドで作り直す（beer-game-scala）。要件・ユースケース・ストーリー・Unit 定義は beer-game2 のものを、設計は beer-game-kotlin のものを、実装規約は [関数型プログラミングガイド（Scala 編）](../../reference/関数型プログラミングガイド_Scala編.md) を正本として参照して流用し、ADR は本書の引き継ぎ表に従って引き継ぐ・変更する・置き換える。

日付: 2026-11-25

## ステータス

提案中（レビュー待ち）

ユーザーが承認したのは、**作成計画**（beer-game-kotlin の設計書を正本とし、Scala 版の設計書 10 本と本 ADR を作る。スタックはガイド準拠）である。本書の**引き継ぎ表の判定**、**Scala 固有の判断**、**版の選定**、**Intent と成功の測り方**は、AI が beer-game-kotlin の ADR・設計書と Scala 編ガイドを読んで作った案で、**人の承認を得ていない**。承認の記録は、承認を得た時点でこの節に追記する。

**ユーザーの決定（2026-11-25）**: 「ローカル DB は Kotlin と同じく H2 で」。ローカル開発（開発機での起動・動作確認）だけ H2 の PostgreSQL モードを使い、統合テスト、CI、受け入れ、ステージング、本番は PostgreSQL 18 のままとする（下の 014 の行、[技術スタック](../../design/beer-game-scala/tech-stack.md) の ST9）。当初 AI が起草した「ローカルも PostgreSQL 18（Docker）のみ」の提案は、この決定により取り下げた。**この決定が含まないもの**: H2 の導入（依存の追加）そのものの承認、H2 の版の確認結果の承認、H2 の PostgreSQL モードでの動作範囲（B1 の最初に実測して確定する）。これらは Kotlin 版と同様に未了である。

**ユーザーの決定（2026-11-25、[設計書レビュー](../../review/beer-game-scala/design_review_20261125.md)の指摘への対応）**: 次の 4 件だけである。

| レビューの指摘 | 決定 |
| :--- | :--- |
| H3 不正な遷移（`Ignored`）の扱い | 止める設計を維持する（Kotlin 版は状態を変えずに検知して続行する。下の「影響」） |
| H6 カバレッジの floor | 行率を算出する案 C を第一とする（scoverage の XML から行率を算出。B1 で確かめる。[テスト戦略](../../design/beer-game-scala/test-strategy.md) の STT2） |
| H7 範囲 | U1〜U3 を約束し、U4〜U6 は指標を見て決める（下の「範囲」） |
| H9 NF-P2 | p95 4 秒に揃える（Rust 版と同じ。[非機能要件](../../design/beer-game-scala/non-functional.md) の SN の項） |

**これら以外の指摘（H1・H2・H4・H5・H8・H10）の直し方は、すべて AI の案で、ユーザーの承認を得ていない**。本書で「H4 案」などと書いたものも同じである。

## コンテキスト

beer-game2 は要件（BR・FR・NFR）、ユースケース、ストーリー、Unit 定義（U1〜U6）を持つ。beer-game-kotlin は、それを正本として、ES + CQRS と関数型コア（Arrow）で設計した（[設計書の入口](../../design/beer-game-kotlin/index.md)、ADR 001〜020）。beer-game-rust は、その設計を Rust に写した前例である（[ADR-001（Rust 版）](../beer-game-rust/001-rust-version-of-beer-game-kotlin.md)）。

Scala 版は、同じ学習の価値を、**型クラスと `IO` の値による合成**（Cats、Cats Effect）で提供することを狙う。Scala の `enum` と `case class` で状態を型にし、失敗を `Either` と `ValidatedNec` で表し、副作用を `IO` と `ConnectionIO` の値として組み立てる。実装規約は Scala 編ガイドで、第 3〜9 章がこの設計の根拠になる。

この選択で、次の問題が生じる。

- 要件や設計を作り直すと、beer-game2・beer-game-kotlin・beer-game-rust との二重管理になり、機能の差が生まれる。
- beer-game-kotlin の ADR の一部は、言語（Arrow、Gradle、detekt、PMD、H2 を JVM から使うこと）に依存しており、そのままでは当てはまらない。どれが有効かを明示しないと、系列の ADR が混在する。
- **Scala は JVM 上で動く**ため、Rust 版と違い、H2 を技術的には使える。H2 の採否は「使えるか」でなく「使う価値があるか」で決める必要がある（下の 014）。
- Scala 編ガイドが採った道具（http4s、doobie、Cats Effect）は、版が 1.0 前（doobie は RC、http4s は 0.23 系が安定、1.0 はマイルストーン）であり、版の固定に注意が要る。
- エンドユーザー（進行役・参加者・観察者・運用担当）に見える機能は Kotlin 版・Rust 版と変わらない。Scala 版の価値はどこにあり、何をもって成功とするか、どこまで作るかを決めないと、同じ運用基盤を 3 つ目の実装に持つ費用に見合うかが判断できない（設計書レビュー H7）。

## Intent・成功の測り方・範囲

### Intent（案）

**この Intent は AI の案で、ユーザーの確認を得ていない。**

beer-game-kotlin と同じ機能と振る舞いを、Scala 3 + Cats Effect の関数型の実装で提供する。価値を受け取るのは、次の 2 者である。

- **Scala の学習者**: 業務ルールを型と純粋な関数で書き、副作用を `IO` と `ConnectionIO` の値として合成する実例を、動くプロダクトの規模で読める。
- **関数型プログラミングガイド（Scala 編）の実証**: ガイドの規約が、ES + CQRS の実プロダクトの規模で成り立つかを確かめる。

参加者に見える画面と API の契約は共有物のため変わらない。したがって、価値は事例・参照実装としてのもので、研修の利用者に新しい機能を足すものではない。

### 成功の測り方（案）

指標は、Rust 版の [リリース計画](../../development/beer-game-rust/release_plan.md) の「ビジネス価値と測定基準」の書き方に倣う。**数値の目標は、すべて B1 の計画で承認を得る（案）。** 計画（`docs/development/beer-game-scala/`）はまだ無い。

| 指標 | 目標（案） | 確認する時期 |
| :--- | :--- | :--- |
| 共有する `apps/beer-game-features/` のうち、Scala のバックエンドで通るシナリオの割合（`@api`・`@ui`） | 約束した範囲（U1〜U3）に対応する許可リストの 100%。許可リストの外は通ると数えない（Rust 版は Release 0.1 で許可リストの 100% としている） | B1 の計画で承認を得る |
| Must のストーリーの受入条件のパリティ（Kotlin 版と同じ受入条件で通る数） | U1〜U3 に含まれる Must のストーリーの全受入条件 | B1 の計画で承認を得る |
| 未確認の前提の数 | B1 の終わりに、[テスト戦略](../../design/beer-game-scala/test-strategy.md) の「B1 の受入条件」の表の全行が、成立・不成立の記録つきで確認済みになる。以降、増えない。状態の正本は [確認状況の一覧](../../design/beer-game-scala/tech-stack.md#確認状況の一覧) | B1 |
| 行カバレッジ | 全体の行 80%（team の floor）を、scoverage の XML から算出して確かめる（案 C。H6 のユーザーの決定）。`domain` の目標（Kotlin 版は行 100% のゲート）は B1 の計画で決める | B1 |
| NF-P2（確定から他の参加者への反映） | p95 4 秒（H9 のユーザーの決定）。実測は B1 で行い、結果を記録する | B1 |
| 規約違反が静的解析で落ちる | 違反コードを実際に置くと失敗する（[テスト戦略](../../design/beer-game-scala/test-strategy.md) の B1 の受入条件の「静的解析」） | B1 |

### 範囲（ユーザーの決定、2026-11-25）

| 区分 | 内容 |
| :--- | :--- |
| **今回の範囲（約束する）** | U1 ウォーキングスケルトン、U2 共同担当と進行の継続、U3 カスタム条件と自動確定（[Unit 定義](../../requirements/beer-game-ts/unit_definition.md)） |
| 範囲外・後回し（指標を見て決める） | U4 学習ビュー（役割別の振り返り、観察者、出力）、U5 保持・運用（保持削除、観測の完成、本番のデプロイ、復元の訓練）、U6 仕上げ（ヘルプ、アクセシビリティの手動確認、性能・負荷の確認、受入）、専用の AWS 環境、CI の新設 |

設計書は、Kotlin 版と同じ文書構成で U1〜U6 の全範囲の設計を扱う。**実装として約束するのは U1〜U3 だけ**で、U4 以降に進むかは、上の指標の結果を見て人が決める。次の 2 点は、AI の指摘で、決定ではない。

- **学習の価値の完結**: Kotlin 版・Rust 版が最優先とする「役割別の振り返り」（US4.2）は U4 にある。U1〜U3 だけでは、研修として振り返りまで完結しない。U4 に進むかの判断で、この点を材料にする。
- **U1 の定義との差**: Unit 定義の U1 は CI/CD と US6.2（ステージングまで）を含む。決定の「専用の AWS 環境・CI の新設は後回し」とは食い違うため、U1 のうちどこまでを約束に含めるかは、B1 の計画で人が決める。

## 決定

- **機能と振る舞いは、beer-game2 を正本として引き継ぐ。** 要件・ユースケース・ストーリー・Unit 定義は新しく作らず、`docs/requirements/beer-game-ts/` を参照する。設計の範囲は beer-game2・beer-game-kotlin と同じ（Unit U1〜U6）で、実装として約束する範囲は、上の「範囲」のとおり U1〜U3 である。
- **設計の構造は、beer-game-kotlin を正本として引き継ぐ。** ES + CQRS、`game` と `session` の 2 ストリーム、状態遷移の純粋関数、投影、保持削除、API の契約（`openapi.yaml`、`code`、problem+json）などの構造は変えず、Scala の表現に置き換える。設計書は `docs/design/beer-game-scala/` に、beer-game-kotlin と同じ文書構成（10 本 + 入口）で作り、各文書に「beer-game-kotlin からの変更」を設ける。言語に依存しない節は、Rust 版の方法に倣い、Kotlin 版の節を参照して継承する。
- **技術スタックは、バックエンドを Scala 3（インデント構文）+ sbt + Cats / Cats Effect + http4s + doobie、フロントエンドを既存の React / TypeScript とする。** 版は設計時（2026-11-25）に Maven Central の `maven-metadata.xml` で確認した値を [技術スタック](../../design/beer-game-scala/tech-stack.md) に記録する。確認できなかったものは「要確認」と書き、B1 で確かめる。
- **コーディングは、関数型プログラミングガイド（Scala 編）に準拠する。** 型は `enum` と `case class`（`copy`）で表し、`val` と不変の `List` だけを使う。業務の失敗は `Either[業務の enum, A]`、独立な検証は `ValidatedNec` と `mapN`、`IO` の失敗は想定外に限る（ガイド ADR-050）。状態の遷移は `handle(state, command): Either[Error, List[Event]]` と `Events.apply` の `foldLeft` の再生で表し、Kotlin 版の `decide` / `evolve` に対応づける。依存は関数を持つ `case class` で受け取り、文脈は `Kleisli` で渡す。`IO` の実行は `IOApp` とテストの境界に限る。
- **ローカル開発の DB は、Kotlin 版と同じく H2 の PostgreSQL モード（ユーザーの決定、2026-11-25）。** ローカル開発だけで、本番・ステージングでは起動時の検査で拒否し、本番イメージに含めない。詳細は下の 014 の行に書く。
- **beer-game-kotlin の ADR は、次の表のとおり扱う。** beer-game-kotlin の ADR のファイルは履歴として変更しない。
- **判断 ID の接頭辞**: ドメインの Scala 固有の判断は `SD1〜`、バックエンドは `SBD1〜`、技術スタックは `ST1〜`、インフラは `SI1〜`、フロントエンドは `SF1〜`、UI 設計は `SU1〜`、テスト戦略は `STT1〜`、非機能要件の判断は `SN1〜`、非機能要件の Scala 固有の追加は `NF-SC1〜`（Scala・Cats 系）とする。**`NF-C1〜C9` は beer-game-kotlin の非機能要件で「容量・同時実行」として既に使われている**（[非機能要件（Kotlin 版）](../../design/beer-game-kotlin/non-functional.md)）ため、`NF-C` を Cats 系に使うと番号が衝突する。このため `NF-SC` とした（2026-11-25、起草時の判断。**未承認**。変更するなら人が決める）。**同じ判断を 2 つの ID で持たない**: JSON ライブラリは ST6、接続プールは ST8 を正本とし、バックエンドの SBD7・SBD11 は、ST6・ST8 を適用する記述として参照にとどめる（SBD7・SBD11 は新しい判断ではない。2026-11-25、設計書レビュー L1 への対応。AI の案）。

### beer-game-kotlin の ADR の引き継ぎ表

扱いは、beer-game-kotlin の ADR 001〜020 の**本文を読んで検証した**案である（**2026-11-25、本文で検証済み**）。初稿は、Rust 版の ADR-001 の引き継ぎ表と各 ADR のステータス節を根拠にした孫引きだったため、ADR 002〜020 の本文（決定・代替案・影響・コンプライアンス・備考）を読み直し、各行の判定と内容を確かめた。検証の結果、**判定（引き継ぐ／変更／置き換える／見直す）は 20 行すべて変わらなかった**が、007・011・013・014 ほか多くの行で、内容と根拠を直した（下の「変更の記録」）。各行の「本文での根拠」は、読んだ節である。

Kotlin 版でのステータスは 2026-11-25 時点の各 ADR の「ステータス」節による（承認済み: 001・002・012・015〜019。015〜018 は 2026-11-15、019 は 2026-11-16 にユーザーが承認。012 は依存の導入の承認が別。ほかは提案中。014 は H2 を使う範囲だけがユーザーの決定、020 は方式をユーザーが選んだが ADR としては提案）。**本書の「引き継ぐ」は、Scala 版の設計としての案であり、Kotlin 版で未承認の ADR の判断を、Scala 版の承認が暗黙に承認することにはならない**。

| beer-game-kotlin の ADR | Scala 版での扱い | 内容 | 本文での根拠 |
| :--- | :--- | :--- | :--- |
| 001 Kotlin 版として作り、要件と ADR を流用（承認済み） | **引き継ぐ**（本書へ） | 正本を流用する方針を Scala 版でも取る | 決定・コンプライアンス（Rust 版 ADR-001 と同じ構成） |
| 002 ES と CQRS、2 ストリーム（承認済み） | **引き継ぐ** | 構造は同じ。`decide` / `evolve` は Scala 版の `handle` / `Events.apply`（`foldLeft`）に読み替える。ストリームの単位（D1）、`StartGame` の原子的な追記（D3）、自動確定が複数のイベントを返す（D6）、`WeekCommitted` が結果と次週の状態を含む（D5）、イベントが表示名と資格を持たない（D7）はそのまま | 決定の 7 項目、代替案、コンプライアンス（個人情報の不在、永続化往復の同値性） |
| 003 投影の同期更新、スナップショットなし、出力は要求時（提案中） | **引き継ぐ** | 構造は同じ。出力は投影にせず、全域の純粋関数 `buildExport` で要求時に作る点も引き継ぐ。**数値は Scala 版で取り直す**: 再生時間の見積もり（千件前後）、同期投影のトランザクション時間（Kotlin 版でも未計測。B1 の縦の最小で最初に計測する）、スナップショット導入の基準。JMH の採否は Scala 版でも未確認（`sbt-jmh` か自前の計測か） | 決定（同期投影、スナップショットなし、出力は投影にしない）、影響、コンプライアンス（反映の保証、導入基準、同期投影の時間） |
| 004 冪等記録は認可の後に置く（提案中） | **引き継ぐ** | 処理順（認証 → 認可の前提検査 → 冪等記録の照合 → 読み込み → `decide` → 追記・投影）、`request_digest` に操作者 ID、成功した応答だけを保存、は言語に依存しない。**実装上の注意**: Kotlin 版は PostgreSQL では一意違反の後のトランザクションが使えないため、冪等記録の同時の重複を `ConcurrencyConflict` に写して再試行の `find` で見つける方式にした。Scala 版も同じ（設計書レビュー M2。契約への明記は設計書側の作業） | 決定、備考の「B1 の実装の結果」（認証は `execute` の中で再試行のたびに評価。一意違反後の扱い） |
| 005 楽観的並行制御と、投影再構築の直列化にアドバイザリロック（提案中。研修中の再構築の運用は暫定） | **引き継ぐ**（実現を変更） | doobie の `ConnectionIO` で実現する。**コルーチンの取消（`NonCancellable`）でトランザクションの終わりを閉じる節**は使えず、Cats Effect のキャンセルの扱い（`Supervisor` による切り離し。[バックエンドアーキテクチャ](../../design/beer-game-scala/architecture-backend.md) の SBD4）に書き換える。**doobie は `Left` を返しても COMMIT する**ため、`Left` で ROLLBACK する規則を明示する（SBD2）。**AI の案（H4、承認なし）**: `Tx.run(program: ConnectionIO[Either[E, A]]): IO[Either[E, A]]` を唯一の公開入口にし、コマンドの `ConnectionIO` 全体を 1 回で包む。`.transact(` の直接の呼び出しは Scalafix で禁止する。**ロックの方式も変わりうる（H5 案、承認なし）**: Kotlin 版はトランザクションの先頭で `pg_advisory_xact_lock_shared` を取り、トランザクションの終わりで自動解放する。Scala 版の案は、`ProjectionLock` を `transact` の外の `Resource[IO, Unit]`、`ChangeNotifier` をトランザクション内で集めて `Tx.run` の後に配信する形（H2 版でも同じ型にするため）で、B1 の最初に実測して確定する。**Kotlin 版でも未決の項目は未決のまま引き継ぐ**: ロック待ちの上限（`lock_timeout`）、再構築中のコマンドの応答、研修中の再構築の運用（停止を依頼する。暫定で人の確認が要る）。SQLSTATE 40001・40P01 を `ConcurrencyConflict` に写す点は、doobie 経由で取れるかを B1 で実測する（[確認状況の一覧](../../design/beer-game-scala/tech-stack.md#確認状況の一覧)） | 決定（一意制約、再試行、アドバイザリロック、`NonCancellable`、`Left` で ROLLBACK）、ネガティブ、未決、コンプライアンス（H7 のトランザクション境界のテスト） |
| 006 イベントのスキーマ進化（アップキャスト、2 段階リリース）（提案中） | **引き継ぐ**（実現を変更） | `EventCodec` を JSON ライブラリ（circe を提案。ST6）で実現する。ドメインのイベントに codec を付けない。変換は `enum` の `match` の網羅で書き、イベントの追加でコンパイルが失敗するようにする。**2 段階リリース（読む → 書く）と N-1 互換の CI ジョブは言語に依存しない**。ただし N-1 互換のジョブは、直前のリリースが無い間は実行しない | 決定（変換の置き場所、アップキャスト、2 段階のリリース、N-1 互換）、コンプライアンス |
| 007 Arrow による関数型コア、Gradle で層を強制（提案中） | **変更**（趣旨は引き継ぎ、実現を置き換える） | 純粋な状態遷移、副作用は境界へ、遷移の全域化、依存の向きの機械的な強制は引き継ぐ。置き換えるのは Arrow（`Either`・`Raise`・`zipOrAccumulate`）と Gradle・detekt・PMD の部分で、`Either`・`ValidatedNec`・`enum` と sbt のプロジェクト境界にする（SD2・SD3）。**趣旨のうち 1 点は意図して変える**: Kotlin 版は、`decide` が作らない列が来たとき**状態を変えずに返し、`InvalidTransition` を検知（ログとメトリクス）して続行する**。Scala 版は、`Evolution.Ignored` が出たら**失敗させて止める**（SD2。ユーザーの決定、2026-11-25。下の「影響」）。`domain` の行カバレッジ 100% のゲートは、scoverage に行の指標が無いため、行率の算出（H6 の案 C）で扱う | 決定（純粋な `decide` / `evolve`、`evolve` は全域で `InvalidTransition` を検知）、コンプライアンス（B2 の `InvalidTransition` の性質テスト、domain 100% のゲート） |
| 008 OpenAPI 手書きと problem+json のエラーコード（提案中） | **引き継ぐ** | 契約（`openapi.yaml`、`code` の一覧）と、フロントエンドの型生成・`@redocly/cli` は共有する（**契約は 2026-11-23 に `apps/beer-game-contracts/` へ移動済み**で、web・Kotlin・Rust・Scala の共有物）。`If-Match` は `SaveDecision` だけ、コマンドの応答は `versions` だけ、`POST /games/:id/start`、`StaleVersion` の廃止も共有する契約の一部。バックエンドの契約テストは、http4s のルートを関数として呼ぶ形（ガイド §7.1）で再実装する。応答のスキーマ検査の道具（networknt `json-schema-validator`、JVM のライブラリ）は、共有できる見込み（採否は設計時。[確認状況の一覧](../../design/beer-game-scala/tech-stack.md#確認状況の一覧)） | 決定、コンプライアンス（B2 の契約テスト 13 件は `app` の test に置いた）、備考（配置の変更 2026-11-23、B1・B2 の実装の結果） |
| 009 観察者を DB ロールで分ける（提案中） | **引き継ぐ** | 接続プールの分け方を doobie の `Transactor`（用途別。HikariCP）で実現する。観察者が読める表を 3 表に限る、参加コードの分離、`week_team_totals` が役割別の値を持たない、`Disclosure` による抑止は構造として同じ。**書き込み用のプールを観察者の経路へ誤って渡す配線ミス**は権限の否定テストでは検出できないため、`current_user` を検査する配線テストが要る。H2 版では DB ロールの分離は省略される（014） | 決定、影響（配線の設定ミス）、コンプライアンス（B1 の権限の否定テスト、B9 の配線テスト） |
| 010 events 追記専用、game_roots の連鎖削除（提案中） | **引き継ぐ** | 構造は言語に依存しない。**権限（GRANT）の否定テストと、`events` に DELETE 権限の無い削除ロールで連鎖削除が動くことは、PostgreSQL の統合テストでだけ検証する**（Kotlin 版は PostgreSQL 18 の 1 回の実測。Scala 版でも同じ確認を取る。H2 版では省略される制約。014）。保持の起点（暫定で作成時）は Kotlin 版でも未決で、人の確認が要る | 決定、備考（B2 の実測）、コンプライアンス（B2 の権限テスト、B11 の削除後の検査） |
| 011 厳格な静的解析（detekt、PMD）（提案中。厳格に適用する方針はユーザーの指示） | **置き換える** | 厳格さの原則（違反 0 件、ベースラインなし、**抑制なし**、緩和は ADR に記録して人が承認、純粋性の静的検査）は引き継ぐ。ツールを scalac のオプション（`-Werror -Wunused:all -Wvalue-discard -Wnonunit-statement`）、Scalafmt、WartRemover、Scalafix（`DisableSyntax`）に置き換える（ガイド第 9 章）。**初稿の「`@SuppressWarnings` は理由なしに使わない」は、Kotlin 版の決定（`@Suppress` とルールの無効化コメントを使わない。緩和は層ごとのルールセットで行い、理由を ADR に記録して人が承認する）より緩いため、本文に合わせて直した**。Kotlin 版が B2 で提案した層単位の緩和（アダプターで `NoThrow` など）は、Kotlin 版でも人の承認が未了のため引き継がない | 決定（厳格さの定義、純粋性の静的検査）、備考（B2 の層ごとのルールセットの緩和は提案・承認待ち） |
| 012 日本語 Gherkin と Cucumber（承認済み。依存の導入の承認は別） | **変更** | 日本語 Gherkin を契約として共有する点（**フィーチャーファイルは 2026-11-23 に `apps/beer-game-features/` へ移動済み**で、`@api`・`@ui` を共有）、タグ（`@US`・`@AC`・層・重要度）による ID の対応、細部とシナリオを二重に書かない規則は引き継ぐ。処理系は、Cucumber-JVM を cucumber-scala に、Kotest を munit に置き換える。ガイドは cucumber-scala を「動いたが `sbt test` には載せず CLI で実行」とし、受け入れの経路の切り替えは関数値の `case class` で行った（ガイド ADR-049）。Scala 版は両方を使う（ST7）。Cucumber の `sbt test` への組み込みはしない | 決定、備考（B1 の実装の結果。2 処理系から 1 か所を参照できた。配置の変更 2026-11-23） |
| 013 技術スタックの版（提案中） | **置き換える**（バックエンド部分）。PostgreSQL 18、Node 26 LTS、フロントエンド・インフラ・CI の版と運用原則は引き継ぐ。**JVM 共通の部分（JDK 25 Temurin、PostgreSQL JDBC、HikariCP、Flyway、Logback、Testcontainers）は、Kotlin 版の確認値を出発点にし、Scala 版での組み合わせを確かめる** | Scala・Cats・http4s・doobie などの版を、確認したうえで固定する（記録先は tech-stack.md の ST1 と版の表）。置き換わるのは Kotlin・Gradle・Ktor・Arrow・kotlinx・Kotest・Kover・Cucumber-JVM・detekt・PMD・ktlint。「ライブラリのサポート期限は書かない」「新規の依存は導入時に承認を得る」「確認日を記録する」「LTS の次の版は実装の期間中に採用しない」は引き継ぐ。Kotlin 版は Node を 24.11.0 で実行した（Node 26 は未導入）ので、Node 26 の確認は Scala 版でも未了とみなす | 決定の版の表と注記、未確認の事項、備考（B1 の実装の結果）。本文は JDK を Kotlin 版のバックエンドの版として固定している |
| 014 ローカル開発だけ H2（提案中。H2 の範囲と両対応はユーザーの決定、2026-11-14） | **引き継ぐ**（読み替え。Scala 版のユーザーの決定、2026-11-25） | Kotlin 版の ADR-014 と T7 を Scala 版に読み替える。ローカル開発だけ H2 の PostgreSQL モード。PostgreSQL 固有の機能（アドバイザリロック、`LISTEN/NOTIFY`）はポート `ProjectionLock`・`ChangeNotifier` の裏に置き、PostgreSQL 版と H2 版を持つ（Kotlin 版の H2 版は `StampedLock` と `MutableSharedFlow`。Scala 版は H5 案）。部分一意索引、DB ロール・GRANT、接続プールの分離、`jsonb` は PostgreSQL の統合テストでだけ検証する。実行する DB は `DB_KIND=postgres\|h2` で選び、**本番・ステージングでは起動時の検査で H2 を拒否**し、**本番イメージに H2 を含めない**（Kotlin 版は二重の防御: 設定の検査で終了コード 78、配布からの `h2-*.jar` の除外）。乖離への対策は、(a) H2 でしか通らない記述の禁止、(b) ポートの契約テストを両実装で実行、(c) 受け入れは PostgreSQL。**Scala 固有の論点**: doobie の `Transactor` は H2 でも使える。`Left` の明示 ROLLBACK（SBD2）は H2 でも同じ。**Kotlin 版の 29 項目の実測は Kotlin 版の値で、Scala 版（doobie 経由）では取り直す**（確認状況は [一覧](../../design/beer-game-scala/tech-stack.md#確認状況の一覧)）。**Rust 版は「H2 は JVM の DB のため使えない」ことを理由にローカルも PostgreSQL のみとしたが、Scala 版は JVM なので H2 を組み込める**（理由が違う）。**H2 の導入は承認待ち、動作範囲は B1 の最初に実測して確定する** | 決定、代替案、コンプライアンス（B1 の最初の実測）、備考（B1・B3 の実装の結果） |
| 015 復帰資格の受け渡しと失効（承認済み） | **引き継ぐ** | 言語に依存しない。失効の書き込みと同じトランザクションでブラウザセッションの行を削除する（H2 案 A）、復帰資格を別の Cookie `bg_recovery` と一度だけ示す復帰コードで渡す（H3 案 A）、`RecoverParticipation` の認可を復帰資格の有効性にして冪等記録の照合より前に置く。**例外が 2 つある**: 応答の本文が `versions` だけという規則に、`createGame` と `reissueCredential` の `recoveryCode` が加わる。「`recoveryCode` を持つ応答の型を、この 2 つに限る」という規則を、Scala 版では型で守る | 決定の H2・H3、設計書との差、未確認（冪等な再送で `recoveryCode` を返せることは Kotlin 版で実測済み） |
| 016 資格の鍵の版（承認済み） | **引き継ぐ** | 言語に依存しない。資格の値の接頭辞（`v<版>.<乱数>`）で鍵の版を示し、版ごとの鍵でダイジェストを検証する。鍵を外すと、その版のすべての資格が使えなくなる。設定名と Terraform の秘密の形への反映は、Kotlin 版でも B14 の前の確認待ち | 決定、影響、未確認 |
| 017 参加・復帰の失敗の窓を DB に持つ（承認済み） | **引き継ぐ** | 言語に依存しない。窓の鍵は正規化した接続元の鍵付き要約で、生の IP を DB にもログにも残さない。順序は「窓に 1 を足す（別のトランザクション）→ 上限超過なら 429 → 検査・実行 → 認可の失敗でなければ 1 を戻す」。**上限 10 回・窓 10 分は根拠のない仮置きで、Scala 版でも未計測**（運営者との合意と実測が要る）。冪等キーの鍵を流用する点（鍵を替えると窓が切れる）は、専用の鍵を持つかを人が決める | 決定、影響、未確認 |
| 018 型の注釈から用語集・イベント一覧を生成（承認済み） | **置き換える** | 方針（型から生成し、不一致を CI で落とす。**手書きの EV 表は残し、生成物との不一致を検査する**）と CI の 4 検査（注釈漏れ、ID 重複、設計書との差、生成物との差）は引き継ぐ。実現（Kotlin の注釈 `Term`・`EventSpec` と、`permittedSubclasses` のリフレクション、`Projection.kt` の走査）は、Scala 3 の注釈（`StaticAnnotation`）、`enum` のメタ情報、scaladoc コメントの走査などから設計時に定める（**未決**）。出力先は `docs/design/beer-game-scala/generated/`（コード着手後） | 決定（注釈、生成、出力、検査）、ネガティブ・リスク（走査が書き方に依存）、承認の範囲（注釈は domain 内、生成は domain のテスト、手書きの EV 表は残す） |
| 019 再試行の上限と間隔（承認済み。2026-11-16） | **見直す**（方針は引き継ぐ） | **方針は引き継ぐ**: 楽観的並行制御と自動再試行を維持し、ジッターを入れず、ゲーム単位の書き込みの直列化をしない。**値は Scala 版で再計測して決める**: 上限 10 は Kotlin 版のローカルの PostgreSQL での計測（4 人・7 人の同時の保存）による。上限は**試行の回数**（同時に N 人が書くと最後の書き手は N 回の試行が要る）。NF-C2（全 60 役割が 10 秒以内）は Kotlin 版でも標本が足りず合否が未解決。書き込みの直列化を採らない理由に H2 版（プロセス内のロック）との相互作用があり、Scala 版でも同じ | 決定（提案）の 1〜3、計測の表、ステータス（上限 10 に変更済み、NF-C2 は未解決）、影響 |
| 020 資格の Cookie の名前をタブごとにする（提案。方式はユーザーが選んだ） | **引き継ぐ** | フロントエンドと HTTP の仕様で、言語に依存しない。画面は共有で、サーバーの側だけを実装する（`X-Tab-Id` が `[A-Za-z0-9]{16,64}` なら Cookie の名前を `bg_session_<識別子>`・`bg_recovery_<識別子>` にし、無い・不正なら従来の名前）。http4s のミドルウェアで Cookie 名を解決する。Kotlin 版でも ADR としては提案で、レビュー待ち | 決定、結果、却下した案 |

#### 変更の記録

- 2026-11-25（設計書レビュー H8 への対応。AI の案）: 本文で検証し、20 行の判定ラベルは維持したまま、次の行の内容と根拠を直した。
  - **005**: ロールの方式が H5 案で変わりうること、未決の項目（`lock_timeout`、再構築中の応答、研修中の運用）が未決のまま引き継がれることを足した。
  - **007**: `InvalidTransition` の扱い（Kotlin 版は状態を変えずに続行、Scala 版は止める）を、置き換えでなく意図して変える趣旨として明記した。
  - **011**: 「`@SuppressWarnings` は理由なしに使わない」を、本文の「抑制なし」に合わせて直した。層単位の緩和を引き継がないことを足した。
  - **013**: JVM 共通の部分（JDK、JDBC、HikariCP など）の扱いを足した。初稿は「バックエンド部分」を一括して置き換える書き方だった。
  - **014**: 読み替えの範囲（Kotlin 版の実測は取り直す、二重の防御）を足した。
  - **003・004・006・008・009・010・012・015〜020**: 本文から、引き継ぐ内容の具体（共有する契約の移動先、承認の範囲、未計測の値）を足した。
  - **019**: 方針と値を分けて書いた（方針は引き継ぎ、値は再計測）。
- 初稿の備考にあった「本文でなく、Rust 版の ADR-001 の引き継ぎ表と各 ADR のステータス節を根拠にした」は、本文での検証により解消した。

### Scala 固有の判断

| 判断 | 内容 | 根拠（ガイド） | 記録先 |
| :--- | :--- | :--- | :--- |
| タグレスファイナルを採らない | 依存は、関数を持つ `case class`（`Hub`、`LogSink` に当たる `Ports`）で渡す | §7.2、§10.1（3 通りを書いて比べ、採らなかった） | [バックエンド](../../design/beer-game-scala/architecture-backend.md) SBD1 |
| `IOLocal` を採らない | 文脈は `Kleisli` で渡す。設定し忘れが実行時にしか分からないため | §7.2、§7.6、§10.2 | 同 SBD1 |
| ZIO を採らない | ガイドの前提は Cats Effect。混在させない | §4 | tech-stack ST2 |
| `EitherT` を使わない | ガイドは試していない。連鎖が短い範囲で `for` と `Either` で足りるかを B1 で確かめ、要れば導入時に承認を得る | §10.1 | tech-stack の未決事項 |
| 業務の失敗は `Either`、`IO` の失敗は想定外に限る | `IO.raiseError` を業務の失敗に使わない | §3.3、ガイド ADR-050 | [ドメインモデル](../../design/beer-game-scala/domain-model.md) SD2 |
| **遷移は `Evolution` で返し、版は永続化の層が持つ。不正な遷移（`Ignored`）は止める**（SD2） | Kotlin 版は `State.version` を持ち、再生側が「版が増えなかった」ことで不正な遷移を検出して続行する。Scala 版は `Events.apply` が `Evolution.Applied / Ignored` を返し、版は `(state, version)` として永続化の層が数える（Rust 版の RD2 と同じ）。`Ignored` が出たら、保存直後でも再生中でも**失敗させて止める**（500・相関 ID。fail closed）。止める設計の維持はユーザーの決定（2026-11-25）。それ以外（`Evolution` の型、版の持ち方）は AI の案で承認なし | §7.3〜§7.4、§7.6（`Versioned`） | ドメイン SD2 |
| **数量・金額の幅は `Long`**（SD7） | `Quantity` は `Int`（0〜1000）、`Units`・`Money` は `Long`。Kotlin 版は `Int`。検査付き演算（`Math.addExact`）は桁あふれで例外を投げ、例外を使わない原則と合わないため採らない。範囲は、ドメインの未決事項 4 で確かめる（AI の案で承認なし） | ガイドに直接の記述なし（例外を使わない原則は §3.3） | ドメイン SD7 |
| `IO` の実行は `IOApp` とテストの境界だけ | `unsafeRunSync` 系を本番コードに置かない（Scalafix で検査） | §4.2、§7.9 | バックエンド SBD5 |
| fs2 を SSE と通知の配信に使う | `Stream[IO, A]` | §4.5 | tech-stack ST2 |
| 代数構造は必要な範囲だけ使う | `TeamTotals` の `Monoid`、`RoleMap` の `Functor`、検証の `ValidatedNec`。法則はテストで確かめる | §6.1〜§6.5、§8.4 | ドメイン SD6 |

SD1・SD3〜SD6 はドメインモデルに記録し、SD3 は下のトレース表で参照する。

### 関数型プログラミングガイド（Scala 編）の各章と設計書の対応（トレース表）

| ガイドの章 | 設計への反映 | 反映先 |
| :--- | :--- | :--- |
| 第 1 章 基礎（純粋関数、引数で受け取る） | ドメインは純粋。時刻・乱数・識別子はコマンドの値として渡す | ドメイン SD5、原則 |
| 第 2 章 関数型スタイル（`val`・不変 `List`・`copy`・`foldLeft`・`for`） | 状態は `case class` と `copy`。再生は `foldLeft` | ドメイン SD1、Game・Session 集約 |
| §3.1〜§3.2 `Option`・`Either` | 業務の失敗は `Either`。`Option` は `toRight` で理由を付ける | ドメイン SD2 |
| §3.3 エラーの型の設計、`-Werror` と `match` の網羅 | エラーの `code` と HTTP の写像を `match` の網羅で付ける | ドメイン SD4、バックエンド SBD8 |
| §3.4 リストの失敗の扱い（best-effort と all-or-nothing） | 設定の検証は all-or-nothing（1 件でも誤りなら全体を失敗にする）。誤りを全件集めるのは下の §6.3 | ドメイン SD3 |
| §3.5 `enum` による ADT | 状態・コマンド・イベント・エラーを `enum` で表す | ドメイン SD1 |
| §4.1〜§4.3 `IO`、純粋な計算と分離 | 副作用は `IO` と `ConnectionIO` の値。核は純粋 | バックエンド 全体構成、SBD5 |
| §4.4 失敗とリトライ | 競合の再試行を `execute` に置く（BD7） | バックエンド 冪等性と競合の再試行 |
| §4.5 ストリーム | SSE の配信、通知の受信に fs2 | バックエンド 通知（SSE） |
| 第 5 章 並行処理（`Ref`・`parSequence`・`Fiber`） | 共有状態は `Ref`、切り離した処理は `Fiber`（`Supervisor` で追跡）、`Thread.sleep` 禁止 | バックエンド SBD4 |
| §6.1 モノイド | `TeamTotals` の畳み込み。再生は `foldLeft` | ドメイン SD6 |
| §6.2 ファンクタ・モナド | `RoleMap` の `map`。`handle` は `for` で連鎖 | ドメイン SD6 |
| §6.3 アプリカティブ（`ValidatedNec`・`mapN`） | 境界の検証で誤りを全件集める | ドメイン SD3 |
| §6.4 プロファンクタ・`imap` | `EventCodec`（行きと戻りの写像） | バックエンド イベントの JSON 変換 |
| §6.5 構造の選び方 | 強い構造から確かめ、足りる弱いものを選ぶ | ドメイン SD6 |
| §7.1 薄い縦串、ルートは関数 | ウォーキングスケルトン。ルートは `Request => IO[Response]` として直接呼ぶ | バックエンド、[テスト戦略](../../design/beer-game-scala/test-strategy.md) |
| §7.2 依存は関数の型 | `Ports` は関数を持つ `case class`。`Kleisli` で渡す | バックエンド SBD1 |
| §7.3〜§7.4 コマンドと状態遷移、イベント | `handle` と `Events.apply`、遷移の「許す組」を列挙して拒否側をテスト | ドメイン Game・Session 集約 |
| §7.5 CQRS | 投影は `Event => List[RowChange]`（`foldLeft` で再構築） | ドメイン 投影 |
| §7.6 永続化とトランザクション境界（`ConnectionIO`・版） | `Versioned` の版による楽観ロック、1 トランザクション | バックエンド SBD2・SBD3 |
| §7.7 バリデーションと境界 | 境界で生の値を検証済みの型に変える | ドメイン SD3 |
| §7.8 監視は合成で足す | `LogRecord`・`LogSink` で項目を型で限定 | バックエンド 観測性 |
| §7.9 全体の形と効果の境界 | 入口は `IOApp`、後始末は `Resource` | バックエンド SBD5 |
| 第 8 章 テスト戦略 | munit、スタブ、プロパティ、法則、Testcontainers、関数値の受け入れ | [テスト戦略](../../design/beer-game-scala/test-strategy.md) |
| 第 9 章 静的解析 | scalac のオプション、Scalafmt、WartRemover、Scalafix | tech-stack ST4、バックエンド モジュール構成と依存の検査 |
| 第 10 章 判断の指針 | 採らない道具の記録（上の表） | 本書 |

### 代替案

- beer-game-kotlin のみを維持する: 手間は小さいが、ユーザーは Scala 版を求めている。
- 要件・設計を Scala 版にコピーして改訂する: 正本が複数になり、差が生まれる。
- Scala の別の枠組み（ZIO + zio-http、Play、Akka/Pekko HTTP）を採る: ガイドの前提が Cats Effect であり、ガイドの道具（http4s、doobie）を使う方針のため採らない。
- 型クラスの代わりに、ガイドが採らなかったタグレスファイナルで書く: 3 通りを書いて比べた結果、ガイドが採らなかった。
- beer-game-kotlin の ADR をすべて有効とする: 層の強制、静的解析、技術スタックの版が Scala 版と矛盾する（H2 は、ユーザーの決定により Kotlin 版と同じく使う）。
- U1〜U6 の全範囲を最初から約束する: 設計は全範囲を持つが、同じ運用基盤を 3 つ目の実装に持つ費用が大きい。ユーザーの決定（2026-11-25）で、U1〜U3 を約束し、U4〜U6 は指標を見て決める。

## 影響

### ポジティブ

- 機能の正本が beer-game2、設計の正本が beer-game-kotlin、実装規約の正本が Scala 編ガイドで、Scala 版は言語による表現の差に集中できる。
- どの判断が引き継がれ、どれが変わったかが、本書の 1 か所で分かる。
- Scala 編ガイドの章と設計書の対応が、トレース表で追える。
- 範囲を U1〜U3 に絞ることで、Scala 版の価値（型クラスと `IO` による合成が動く規模で成り立つか）を、早く確かめられる。

### ネガティブ

- 四つの系列（beer-game2、beer-game-kotlin、Rust 版、Scala 版）の文書を、読み手が参照する必要がある。
- beer-game-kotlin の設計が変わると、Scala 版にも影響する。変更は正本側で行い、Scala 版へ追従する。追従の確認は、共有する `apps/beer-game-features/` の通過率（上の指標）で行う。
- 引き継ぎ元の ADR の多くは Kotlin 版でも未承認のため、Kotlin 版で内容が変わると、この表の「引き継ぐ」が揺らぐ。003・019 の計測値（千件の再生時間、再試行の上限 10）と 017 の仮置き値（10 回・10 分）は、Scala 版で取り直す。
- doobie が RC 版で、http4s の安定版が 0.23 系である。更新のたびに破壊的変更の影響を調べる運用が要る。
- ローカル開発の H2 により、ローカルと CI の乖離のリスクを負う。ポートの 2 実装と契約テストの両実行の維持費がかかり、H2 版では省略した制約（追記専用、ロールの分離など）がローカルで守られない。Scala 版では H2 の動作範囲を未実測のため、B1 の最初に確かめる。
- **不正な遷移で止めることは、Kotlin 版との、利用者に見える差である。** Kotlin 版は、`decide` が作らない列が来ても状態を変えず、検知して続行する。Scala 版は、`Ignored` が出たゲームの操作を止める（500・相関 ID）。正しさを優先する決定（2026-11-25）だが、研修中に止まると、進行役と参加者に見える。止まるのは該当ゲームだけで、研修中の運用（進行役への依頼、DB 全体の復元を研修時間に行わない原則）は、[運用要件](../../design/beer-game-scala/operation.md) の障害対応で定める（本書では約束しない）。
- 範囲を U1〜U3 に絞ると、役割別の振り返り（US4.2。U4）が無いため、研修として完結しない。範囲の決定の材料にする（上の「範囲」）。

## コンプライアンス

- **契約の流用**: ストーリーの受入条件を Gherkin のシナリオにタグで対応付け、CI で対応表を検査する方針を引き継ぐ。Scala 版での実現はテスト戦略で定める。
- **API の契約が変わらないこと**: beer-game-kotlin の E2E のシナリオが Scala 版でそのまま使えるかを、最初の Bolt までに確かめる。変わる場合は設計の矛盾として扱う。
- **引き継ぎ表の整合**: 各行は、2026-11-25 に ADR の本文を読んで検証した。人のレビューで確認する。Kotlin 版の ADR が変わったときは、該当の行を見直す。
- **beer-game-kotlin の ADR を変更しないこと**（履歴）。
- **版の記録**: 版は確認日と確認の手段を添えて書き、推測の版を事実として書かない。
- **確認状況の記載**: 確認した事項・未確認の事項の状態は、[確認状況の一覧](../../design/beer-game-scala/tech-stack.md#確認状況の一覧) に 1 か所だけ持つ。本書には状態を複製しない。

## 備考

- 著者: claude-code
- 確認済み: Rust 版の ADR-001 と、beer-game-kotlin の設計書（tech-stack、domain-model、architecture-backend）、Scala 編ガイドの全体、beer-game-kotlin の ADR 002〜020 の本文（2026-11-25。引き継ぎ表の検証）を読んだ。014 と 011・012・018 の Scala 版の扱いは、本書の案である。
- 確認状況: Scala 版の各ライブラリの機能（doobie の `FC.rollback` と PostgreSQL の通知、http4s ember の切断時の挙動、cucumber-scala と日本語 Gherkin、scoverage の Scala 3 での分岐の計測、実 DB での動作など）と、設計時に検証した範囲（版、断片のコンパイルとテスト）の状態は、[確認状況の一覧](../../design/beer-game-scala/tech-stack.md#確認状況の一覧) を唯一の正本とする（設計書レビュー H1。AI の案）。
- 関連 ADR: beer-game-kotlin の [ADR-001](../beer-game-kotlin/001-kotlin-version-of-beer-game2.md)、[ADR-002](../beer-game-kotlin/002-event-sourcing-and-cqrs.md)、[ADR-007](../beer-game-kotlin/007-functional-core-with-arrow.md)、[ADR-014](../beer-game-kotlin/014-h2-for-local-development.md)。Rust 版の [ADR-001](../beer-game-rust/001-rust-version-of-beer-game-kotlin.md)。beer-game2 の [ADR-001](../beer-game-ts/001-rebuild-as-beer-game2.md)
- 参照: [beer-game-kotlin の設計書](../../design/beer-game-kotlin/index.md)、[関数型プログラミングガイド（Scala 編）](../../reference/関数型プログラミングガイド_Scala編.md)、[ユーザーストーリー](../../requirements/beer-game-ts/user_story.md)、[Unit 定義](../../requirements/beer-game-ts/unit_definition.md)、[設計書レビュー（2026-11-25）](../../review/beer-game-scala/design_review_20261125.md)、[リリース計画（Rust 版）](../../development/beer-game-rust/release_plan.md)
