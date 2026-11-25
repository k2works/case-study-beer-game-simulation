---
type: ADR
title: "ADR-001: beer-game-kotlin を Scala 版として作り、設計と ADR を流用する"
description: "beer-game2 の要件・ストーリー・Unit 定義と beer-game-kotlin の設計を正本として流用し、Scala 3（Cats Effect + http4s + doobie）と既存の React で作り直す。beer-game-kotlin の ADR の引き継ぎ表、Scala 固有の判断、関数型プログラミングガイド（Scala 編）の各章から設計書へのトレース表を含む。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-25T06:10:00Z }
---

# ADR-001: beer-game-kotlin を Scala 版として作り、設計と ADR を流用する

beer-game-kotlin と同じ機能と振る舞いを、Scala 3（Cats Effect + http4s + doobie）のバックエンドと既存の React のフロントエンドで作り直す（beer-game-scala）。要件・ユースケース・ストーリー・Unit 定義は beer-game2 のものを、設計は beer-game-kotlin のものを、実装規約は [関数型プログラミングガイド（Scala 編）](../../reference/関数型プログラミングガイド_Scala編.md) を正本として参照して流用し、ADR は本書の引き継ぎ表に従って引き継ぐ・変更する・置き換える。

日付: 2026-11-25

## ステータス

提案中（レビュー待ち）

ユーザーが承認したのは、**作成計画**（beer-game-kotlin の設計書を正本とし、Scala 版の設計書 10 本と本 ADR を作る。スタックはガイド準拠）である。本書の**引き継ぎ表の判定**、**Scala 固有の判断**、**版の選定**は、AI が beer-game-kotlin の ADR・設計書と Scala 編ガイドを読んで作った案で、**人の承認を得ていない**。承認の記録は、承認を得た時点でこの節に追記する。

**ユーザーの決定（2026-11-25）**: 「ローカル DB は Kotlin と同じく H2 で」。ローカル開発（開発機での起動・動作確認）だけ H2 の PostgreSQL モードを使い、統合テスト、CI、受け入れ、ステージング、本番は PostgreSQL 18 のままとする（下の 014 の行、[技術スタック](../../design/beer-game-scala/tech-stack.md) の ST9）。当初 AI が起草した「ローカルも PostgreSQL 18（Docker）のみ」の提案は、この決定により取り下げた。**この決定が含まないもの**: H2 の導入（依存の追加）そのものの承認、H2 の版の確認結果の承認、H2 の PostgreSQL モードでの動作範囲（B1 の最初に実測して確定する）。これらは Kotlin 版と同様に未了である。

## コンテキスト

beer-game2 は要件（BR・FR・NFR）、ユースケース、ストーリー、Unit 定義（U1〜U6）を持つ。beer-game-kotlin は、それを正本として、ES + CQRS と関数型コア（Arrow）で設計した（[設計書の入口](../../design/beer-game-kotlin/index.md)、ADR 001〜020）。beer-game-rust は、その設計を Rust に写した前例である（[ADR-001（Rust 版）](../beer-game-rust/001-rust-version-of-beer-game-kotlin.md)）。

Scala 版は、同じ学習の価値を、**型クラスと `IO` の値による合成**（Cats、Cats Effect）で提供することを狙う。Scala の `enum` と `case class` で状態を型にし、失敗を `Either` と `ValidatedNec` で表し、副作用を `IO` と `ConnectionIO` の値として組み立てる。実装規約は Scala 編ガイドで、第 3〜9 章がこの設計の根拠になる。

この選択で、次の問題が生じる。

- 要件や設計を作り直すと、beer-game2・beer-game-kotlin・beer-game-rust との二重管理になり、機能の差が生まれる。
- beer-game-kotlin の ADR の一部は、言語（Arrow、Gradle、detekt、PMD、H2 を JVM から使うこと）に依存しており、そのままでは当てはまらない。どれが有効かを明示しないと、系列の ADR が混在する。
- **Scala は JVM 上で動く**ため、Rust 版と違い、H2 を技術的には使える。H2 の採否は「使えるか」でなく「使う価値があるか」で決める必要がある（下の 014）。
- Scala 編ガイドが採った道具（http4s、doobie、Cats Effect）は、版が 1.0 前（doobie は RC、http4s は 0.23 系が安定、1.0 はマイルストーン）であり、版の固定に注意が要る。

## 決定

- **機能と振る舞いは、beer-game2 を正本として引き継ぐ。** 要件・ユースケース・ストーリー・Unit 定義は新しく作らず、`docs/requirements/beer-game-ts/` を参照する。範囲は beer-game2・beer-game-kotlin と同じ（Unit U1〜U6）。
- **設計の構造は、beer-game-kotlin を正本として引き継ぐ。** ES + CQRS、`game` と `session` の 2 ストリーム、状態遷移の純粋関数、投影、保持削除、API の契約（`openapi.yaml`、`code`、problem+json）などの構造は変えず、Scala の表現に置き換える。設計書は `docs/design/beer-game-scala/` に、beer-game-kotlin と同じ文書構成（10 本 + 入口）で作り、各文書に「beer-game-kotlin からの変更」を設ける。言語に依存しない節は、Rust 版の方法に倣い、Kotlin 版の節を参照して継承する。
- **技術スタックは、バックエンドを Scala 3（インデント構文）+ sbt + Cats / Cats Effect + http4s + doobie、フロントエンドを既存の React / TypeScript とする。** 版は設計時（2026-11-25）に Maven Central の `maven-metadata.xml` で確認した値を [技術スタック](../../design/beer-game-scala/tech-stack.md) に記録する。確認できなかったものは「要確認」と書き、B1 で確かめる。
- **コーディングは、関数型プログラミングガイド（Scala 編）に準拠する。** 型は `enum` と `case class`（`copy`）で表し、`val` と不変の `List` だけを使う。業務の失敗は `Either[業務の enum, A]`、独立な検証は `ValidatedNec` と `mapN`、`IO` の失敗は想定外に限る（ガイド ADR-050）。状態の遷移は `handle(state, command): Either[Error, List[Event]]` と `Events.apply` の `foldLeft` の再生で表し、Kotlin 版の `decide` / `evolve` に対応づける。依存は関数を持つ `case class` で受け取り、文脈は `Kleisli` で渡す。`IO` の実行は `IOApp` とテストの境界に限る。
- **ローカル開発の DB は、Kotlin 版と同じく H2 の PostgreSQL モード（ユーザーの決定、2026-11-25）。** ローカル開発だけで、本番・ステージングでは起動時の検査で拒否し、本番イメージに含めない。詳細は下の 014 の行に書く。
- **beer-game-kotlin の ADR は、次の表のとおり扱う。** beer-game-kotlin の ADR のファイルは履歴として変更しない。
- **判断 ID の接頭辞**: ドメインの Scala 固有の判断は `SD1〜`、バックエンドは `SBD1〜`、技術スタックは `ST1〜`、非機能要件の Scala 固有の追加は `NF-SC1〜`（Scala・Cats 系）とする。**`NF-C1〜C9` は beer-game-kotlin の非機能要件で「容量・同時実行」として既に使われている**（[非機能要件（Kotlin 版）](../../design/beer-game-kotlin/non-functional.md)）ため、`NF-C` を Cats 系に使うと番号が衝突する。このため `NF-SC` とした（2026-11-25、起草時の判断。変更するなら人が決める）。

### beer-game-kotlin の ADR の引き継ぎ表

扱いは、beer-game-kotlin の ADR 001〜020 の**見出しと決定の要旨を読んだうえでの案**である（2026-11-25）。各行は、Scala 版の設計書を起こす時点で本文を読んで確認すること（Rust 版と同じ運用）。Kotlin 版でのステータスは 2026-11-25 時点の各 ADR の「ステータス」節による（承認済み: 001・002・012・015〜019。015 は承認の範囲が節ごとに書かれている。ほかは提案中。020 は方式をユーザーが選んだが本書の承認はレビュー待ち）。

| beer-game-kotlin の ADR | Scala 版での扱い | 内容 |
| :--- | :--- | :--- |
| 001 Kotlin 版として作り、要件と ADR を流用 | **引き継ぐ**（本書へ） | 正本を流用する方針を Scala 版でも取る |
| 002 ES と CQRS、2 ストリーム | **引き継ぐ** | 構造は同じ |
| 003 投影の同期更新、スナップショットなし | **引き継ぐ** | 構造は同じ。再生時間の計測値（千件）は JVM だが、Scala の実装で取り直す |
| 004 冪等記録は認可の後に置く | **引き継ぐ** | 言語に依存しない |
| 005 楽観的並行制御と、投影再構築の直列化にアドバイザリロック | **引き継ぐ**（実現を変更） | doobie の `ConnectionIO` で実現する。コルーチンの取消（`NonCancellable`）の節は使えず、Cats Effect のキャンセルの扱い（`Supervisor` による切り離し。[バックエンドアーキテクチャ](../../design/beer-game-scala/architecture-backend.md) の SBD4）に書き換える。**doobie は `Left` を返しても COMMIT する**ため、`Left` で ROLLBACK する規則を明示する（SBD2） |
| 006 イベントのスキーマ進化（アップキャスト、2 段階リリース） | **引き継ぐ**（実現を変更） | `EventCodec` を JSON ライブラリ（circe を提案。ST6）で実現する。ドメインのイベントに codec を付けない |
| 007 Arrow による関数型コア、Gradle で層を強制 | **変更**（趣旨は引き継ぎ、実現を置き換える） | 純粋な状態遷移、副作用は境界へ、遷移の全域化、依存の向きの機械的な強制は引き継ぐ。置き換えるのは Arrow（`Either`・`Raise`・`zipOrAccumulate`）と Gradle・detekt・PMD の部分で、`Either`・`ValidatedNec`・`enum` と sbt のプロジェクト境界にする（SD2・SD3） |
| 008 OpenAPI 手書きと problem+json のエラーコード | **引き継ぐ** | 契約（`openapi.yaml`、`code` の一覧）と、フロントエンドの型生成・`@redocly/cli` は共有する。バックエンドの契約テストは、http4s のルートを関数として呼ぶ形（ガイド §7.1）で再実装する。応答のスキーマ検査の道具は JVM のライブラリを共有できる見込み（採否は設計時。要確認） |
| 009 観察者を DB ロールで分ける | **引き継ぐ** | 接続プールの分け方を doobie の `Transactor`（用途別。HikariCP）で実現する |
| 010 events 追記専用、game_roots の連鎖削除 | **引き継ぐ** | 言語に依存しない |
| 011 厳格な静的解析（detekt、PMD） | **置き換える** | 厳格さの原則（違反 0 件、ベースラインなし、抑制なし、緩和は ADR に記録して人が承認、純粋性の静的検査）は引き継ぐ。ツールを scalac のオプション（`-Werror -Wunused:all -Wvalue-discard -Wnonunit-statement`）、Scalafmt、WartRemover、Scalafix（`DisableSyntax`）に置き換える（ガイド第 9 章）。`@SuppressWarnings` は理由なしに使わない |
| 012 日本語 Gherkin と Cucumber | **変更** | 日本語 Gherkin を契約として共有する点は引き継ぐ。ガイドは cucumber-scala を「動いたが `sbt test` には載せず CLI で実行」とし、受け入れの経路の切り替えは関数値の `case class` で行った（ガイド ADR-049）。Scala 版は両方を使う（ST7）。Cucumber の `sbt test` への組み込みはしない |
| 013 技術スタックの版 | **置き換える**（バックエンド部分）。PostgreSQL 18、Node 26 LTS、フロントエンド・インフラ・CI の版と運用原則は引き継ぐ | Scala・Cats・http4s・doobie などの版を、確認したうえで固定する（記録先は tech-stack.md の ST1 と版の表）。「ライブラリのサポート期限は書かない」「新規の依存は導入時に承認を得る」「確認日を記録する」は引き継ぐ |
| 014 ローカル開発だけ H2 | **引き継ぐ**（読み替え。ユーザーの決定、2026-11-25） | Kotlin 版の ADR-014 と T7 を Scala 版に読み替える。ローカル開発だけ H2 の PostgreSQL モード。PostgreSQL 固有の機能（アドバイザリロック、`LISTEN/NOTIFY`）はポート `ProjectionLock`・`ChangeNotifier` の裏に置き、PostgreSQL 版と H2 版を持つ。部分一意索引、DB ロール・GRANT、接続プールの分離、`jsonb` は PostgreSQL の統合テストでだけ検証する。実行する DB は `DB_KIND=postgres\|h2` で選び、**本番・ステージングでは起動時の検査で H2 を拒否**し、**本番イメージに H2 を含めない**。乖離への対策は、(a) H2 でしか通らない記述の禁止、(b) ポートの契約テストを両実装で実行、(c) 受け入れは PostgreSQL。**Scala 固有の論点**: doobie の `Transactor` は H2 でも使える（doobie-h2 の要否、doobie 経由の SQLSTATE と制約名の取得は**未確認**。B1 で実測）。`Left` の明示 ROLLBACK（SBD2）は H2 でも同じ。**Rust 版は「H2 は JVM の DB のため使えない」ことを理由にローカルも PostgreSQL のみとしたが、Scala 版は JVM なので H2 を組み込める**（理由が違う）。H2 の版（2.5.252）とライセンス（MPL 2.0・EPL 1.0）は 2026-11-25 に Maven Central で確認した。**H2 の導入は承認待ち、動作範囲は B1 の最初に実測して確定する** |
| 015 復帰資格の受け渡しと失効 | **引き継ぐ** | 言語に依存しない |
| 016 資格の鍵の版 | **引き継ぐ** | 言語に依存しない |
| 017 参加・復帰の失敗の窓を DB に持つ | **引き継ぐ** | 言語に依存しない |
| 018 型の注釈から用語集・イベント一覧を生成 | **置き換える** | 方針（型から生成し、不一致を CI で落とす）と CI の 4 検査（注釈漏れ、ID 重複、設計書との差、生成物との差）は引き継ぐ。実現（Kotlin の注釈とリフレクション）は、Scala 3 の注釈（`StaticAnnotation`）、`enum` のメタ情報、scaladoc コメントの走査などから設計時に定める（**未決**）。出力先は `docs/design/beer-game-scala/generated/`（コード着手後） |
| 019 再試行の上限と間隔 | **見直す** | 値は Kotlin 版の計測にもとづく。Scala 版で再計測して決める（初期値は 10） |
| 020 資格の Cookie の名前をタブごとにする | **引き継ぐ** | フロントエンドと HTTP の仕様で、言語に依存しない。http4s のミドルウェアで Cookie 名を解決する。Kotlin 版でも「提案」で、レビュー待ち |

### Scala 固有の判断

| 判断 | 内容 | 根拠（ガイド） | 記録先 |
| :--- | :--- | :--- | :--- |
| タグレスファイナルを採らない | 依存は、関数を持つ `case class`（`Hub`、`LogSink` に当たる `Ports`）で渡す | §7.2、§10.1（3 通りを書いて比べ、採らなかった） | [バックエンド](../../design/beer-game-scala/architecture-backend.md) SBD1 |
| `IOLocal` を採らない | 文脈は `Kleisli` で渡す。設定し忘れが実行時にしか分からないため | §7.2、§7.6、§10.2 | 同 SBD1 |
| ZIO を採らない | ガイドの前提は Cats Effect。混在させない | §4 | tech-stack ST2 |
| `EitherT` を使わない | ガイドは試していない。連鎖が短い範囲で `for` と `Either` で足りるかを B1 で確かめ、要れば導入時に承認を得る | §10.1 | tech-stack の未決事項 |
| 業務の失敗は `Either`、`IO` の失敗は想定外に限る | `IO.raiseError` を業務の失敗に使わない | §3.3、ガイド ADR-050 | [ドメインモデル](../../design/beer-game-scala/domain-model.md) SD2 |
| `IO` の実行は `IOApp` とテストの境界だけ | `unsafeRunSync` 系を本番コードに置かない（Scalafix で検査） | §4.2、§7.9 | バックエンド SBD5 |
| fs2 を SSE と通知の配信に使う | `Stream[IO, A]` | §4.5 | tech-stack ST2 |
| 代数構造は必要な範囲だけ使う | `TeamTotals` の `Monoid`、`RoleMap` の `Functor`、検証の `ValidatedNec`。法則はテストで確かめる | §6.1〜§6.5、§8.4 | ドメイン SD6 |

### 関数型プログラミングガイド（Scala 編）の各章と設計書の対応（トレース表）

| ガイドの章 | 設計への反映 | 反映先 |
| :--- | :--- | :--- |
| 第 1 章 基礎（純粋関数、引数で受け取る） | ドメインは純粋。時刻・乱数・識別子はコマンドの値として渡す | ドメイン SD5、原則 |
| 第 2 章 関数型スタイル（`val`・不変 `List`・`copy`・`foldLeft`・`for`） | 状態は `case class` と `copy`。再生は `foldLeft` | ドメイン SD1、Game・Session 集約 |
| §3.1〜§3.2 `Option`・`Either` | 業務の失敗は `Either`。`Option` は `toRight` で理由を付ける | ドメイン SD2 |
| §3.3 エラーの型の設計、`-Werror` と `match` の網羅 | エラーの `code` と HTTP の写像を `match` の網羅で付ける | ドメイン SD4、バックエンド SBD8 |
| §3.4 リストの失敗の扱い | 設定の検証は all-or-nothing で、誤りは全件集める | ドメイン SD3 |
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

## 影響

### ポジティブ

- 機能の正本が beer-game2、設計の正本が beer-game-kotlin、実装規約の正本が Scala 編ガイドで、Scala 版は言語による表現の差に集中できる。
- どの判断が引き継がれ、どれが変わったかが、本書の 1 か所で分かる。
- Scala 編ガイドの章と設計書の対応が、トレース表で追える。

### ネガティブ

- 四つの系列（beer-game2、beer-game-kotlin、Rust 版、Scala 版）の文書を、読み手が参照する必要がある。
- beer-game-kotlin の設計が変わると、Scala 版にも影響する。変更は正本側で行い、Scala 版へ追従する。
- 引き継ぎ元の ADR の多くは Kotlin 版でも未承認のため、Kotlin 版で内容が変わると、この表の「引き継ぐ」が揺らぐ。003・019 の計測値（千件の再生時間、再試行の上限 10）と 017 の仮置き値（10 回・10 分）は、Scala 版で取り直す。
- doobie が RC 版で、http4s の安定版が 0.23 系である。更新のたびに破壊的変更の影響を調べる運用が要る。
- ローカル開発の H2 により、ローカルと CI の乖離のリスクを負う。ポートの 2 実装と契約テストの両実行の維持費がかかり、H2 版では省略した制約（追記専用、ロールの分離など）がローカルで守られない。Scala 版では H2 の動作範囲を未実測のため、B1 の最初に確かめる。

## コンプライアンス

- **契約の流用**: ストーリーの受入条件を Gherkin のシナリオにタグで対応付け、CI で対応表を検査する方針を引き継ぐ。Scala 版での実現はテスト戦略で定める。
- **API の契約が変わらないこと**: beer-game-kotlin の E2E のシナリオが Scala 版でそのまま使えるかを、最初の Bolt までに確かめる。変わる場合は設計の矛盾として扱う。
- **引き継ぎ表の整合**: 各行を、Scala 版の設計書を起こす時点で本文を読んで確認すること。レビューで確認する。
- **beer-game-kotlin の ADR を変更しないこと**（履歴）。
- **版の記録**: 版は確認日と確認の手段を添えて書き、推測の版を事実として書かない。

## 備考

- 著者: claude-code
- 確認済み: Rust 版の ADR-001 と、beer-game-kotlin の設計書（tech-stack、domain-model、architecture-backend）、Scala 編ガイドの全体を読んだ（2026-11-25）。beer-game-kotlin の ADR 002〜020 は**本文でなく、Rust 版の ADR-001 の引き継ぎ表と各 ADR のステータス節**を根拠にした。014 と 011・012・018 の Scala 版の扱いは、本書の案である。
- 未確認: Scala 版の各ライブラリの機能（doobie の `HC.rollback` と PostgreSQL の通知、http4s ember の切断時の挙動、cucumber-scala と日本語 Gherkin、scoverage の Scala 3 での分岐の計測）は設計時に確認していない。tech-stack の「要確認」の項目と未決事項に集約した。
- 検証した範囲: sbt 1.13.1、Scala 3.7.4、WartRemover 3.6.3、cats-core 2.13.0、cats-effect 3.7.1、doobie-core 1.0.0-RC12、munit 1.3.6 で、ドメインの断片（値オブジェクト、`ValidatedNec`、`handle`、`Events.apply`）と、アプリケーションの `execute` の断片のコンパイルと 2 件のテストの成功を確認した。実 DB での動作は確認していない（2026-11-25。詳細は [ドメインモデル](../../design/beer-game-scala/domain-model.md) と [バックエンドアーキテクチャ](../../design/beer-game-scala/architecture-backend.md) の「確認の範囲」）。
- 関連 ADR: beer-game-kotlin の [ADR-001](../beer-game-kotlin/001-kotlin-version-of-beer-game2.md)、[ADR-002](../beer-game-kotlin/002-event-sourcing-and-cqrs.md)、[ADR-007](../beer-game-kotlin/007-functional-core-with-arrow.md)、[ADR-014](../beer-game-kotlin/014-h2-for-local-development.md)。Rust 版の [ADR-001](../beer-game-rust/001-rust-version-of-beer-game-kotlin.md)。beer-game2 の [ADR-001](../beer-game-ts/001-rebuild-as-beer-game2.md)
- 参照: [beer-game-kotlin の設計書](../../design/beer-game-kotlin/index.md)、[関数型プログラミングガイド（Scala 編）](../../reference/関数型プログラミングガイド_Scala編.md)、[ユーザーストーリー](../../requirements/beer-game-ts/user_story.md)、[Unit 定義](../../requirements/beer-game-ts/unit_definition.md)
