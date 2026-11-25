# beer-game-scala — 設計

beer-game-scala プロジェクトの設計ドキュメントです。beer-game-kotlin の設計を正本とし、実装規約は [関数型プログラミングガイド（Scala 編）](../../reference/関数型プログラミングガイド_Scala編.md) に準拠します。要件・ストーリー・Unit は beer-game-ts（旧 beer-game2）を正本とします。派生の経緯と引き継ぎ表は [ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md) にあります。

## ドキュメント一覧

### アーキテクチャ

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [バックエンドアーキテクチャ](./architecture-backend.md) | sbt のモジュール分割、`IO` と `ConnectionIO` の境界、`handle` / `apply`、`Kleisli` による文脈 | Draft |
| [フロントエンドアーキテクチャ](./architecture-frontend.md) | React 画面の共有と、Scala 版バックエンドとの接点の差分 | Draft |
| [インフラストラクチャ](./architecture-infrastructure.md) | 実行環境、sbt によるビルド、コンテナ、デプロイ構成 | Draft |

### モデル設計

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [データモデル設計](./data-model.md) | 論理データモデル、テーブル定義、doobie との対応 | Draft |
| [ドメインモデル設計](./domain-model.md) | 集約、`enum` による状態・コマンド・イベント・誤り、`Evolution` | Draft |

### UI/UX設計

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [UI 設計](./ui-design.md) | 画面設計は Kotlin 版を継承し、差分だけを整理 | Draft |

### 品質・運用

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [テスト戦略](./test-strategy.md) | munit、代数法則のテスト、Testcontainers、受け入れテスト、静的解析 | Draft |
| [非機能要件](./non-functional.md) | 性能、可用性、セキュリティ、保守性、拡張性（NF-SC の追加を含む） | Draft |
| [運用要件](./operation.md) | `LogRecord` による監視、バックアップ、デプロイ、障害対応 | Draft |

### その他

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [技術スタック選定](./tech-stack.md) | Scala 3、Cats Effect、http4s、doobie など。版は Maven Central で確認した値 | Draft |

## 範囲（ユーザーの決定、2026-11-25）

| 区分 | 内容 |
| :--- | :--- |
| 今回の範囲（約束する） | U1 ウォーキングスケルトン、U2 共同担当と進行の継続、U3 カスタム条件と自動確定。U1 には検証用の CI（`check` ジョブ 1 本）を含む |
| 範囲外・後回し | U4 学習ビュー、U5 保持・運用、U6 仕上げ、専用の AWS 環境、デプロイ用ワークフロー、ステージングへの自動反映、本番運用・復元訓練。U4〜U6 に進むかは指標を見て決める |

設計書は U1〜U6 の全範囲の設計を扱いますが、実装として約束するのは U1〜U3 だけです。Intent（案）と成功の測り方（案）は [ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md) にあります。

- **U1〜U3 の間は実際の研修に使いません（検証・事例用。ユーザーの決定）。** U5 の保持削除（US5.1、Must）が範囲外で参加者の表示名が期限後も消えず、U4 の役割別の振り返り（US4.2）が範囲外で研修として完結しないためです。
- 指標のうち Must のパリティは、U1 の US6.1（CI）を `check` ジョブの範囲で含め、US6.2（ステージングまで）は AWS・デプロイが後回しのため範囲外とします。許可リストは U1〜U3 の `@AC` タグから導きます。NF-P2 の実測は範囲外（U6）の性能を早めに計測するもので、約束ではありません。
- ステージングへの自動反映を持たない間は、team 規約（Mandated）の例外が要ります。例外は ADR-001 に**案として**記録しており、**人の承認を待っています**。

## ユーザーの決定（2026-11-25）

承認済みの判断は、次の 9 件だけです（ローカル DB の 1 件と、レビューへの回答 8 件。作成計画の承認を除く）。それ以外は、すべて AI の案で、ユーザーの承認を得ていません。作成計画の承認（ガイド準拠）から導かれるのは Scala 3・sbt・Cats Effect・http4s・doobie という道具の系列までで、具体的な版（例: Scala 3.7.4）や circe・HikariCP などの個別の選定は AI の案です。

| 決定 | 内容 | 出典 |
| :--- | :--- | :--- |
| ローカル DB | H2 の PostgreSQL モード（ST9）。H2 の導入の承認と動作範囲の実測は残る | [ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md)、[技術スタック](./tech-stack.md) |
| 不正な遷移（`Ignored`） | 止める設計を維持する（Kotlin 版は続行。利用者に見える差） | [設計書レビュー](../../review/beer-game-scala/design_review_20261125.md) H3 |
| カバレッジ | 行率を算出する案 C を第一とする（B1 で確かめる） | 同 H6 |
| 範囲 | U1〜U3 を約束し、U4〜U6 は指標を見て決める（最初の決定） | 同 H7 |
| NF-P2 | p95 4 秒に揃える | 同 H9 |
| CI と AWS の線引き | 検証用の CI（`check` ジョブ 1 本）は U1 の約束に含める。AWS 環境・デプロイ用ワークフロー・ステージングへの自動反映は後回し（再レビュー後の決定）。team 規約の例外は案で未承認 | [設計書の再レビュー](../../review/beer-game-scala/design_rereview_20261125.md) N-H4 |
| `domain` の文 97% | 目安とする。ゲートにするかは B1 の実測の後に決める | 同 N-H6 |
| 止まったゲームの読み取り | 止まったゲームでも状態の取得（読み取り）は返すことを要件にする | 同 N-H7 |
| U1〜U3 の用途 | 実際の研修に使わない（検証・事例用） | 同 N-H8 |

再レビューの N-H1（許す組の表を規範にする）・N-H2（`ProjectionLock` は `ConnectionIO` の変換）・N-H3（`.transact(` の許可する入口の一覧）・N-H5（確認状況の正本の規則）の直し方は、**AI の案で承認を得ていません**。

## 設計判断

次の判断は、上の 5 件の決定を除き、すべて**案**で、ユーザーの承認を得ていません。承認の記録は、ユーザーが指示した範囲だけを追記します。

| 判断 | 内容 | 状態 | 文書 |
| :--- | :--- | :--- | :--- |
| ADR-001 | beer-game-kotlin を Scala 版として作り、設計と ADR を流用する。引き継ぎ表は 2026-11-25 に AI が ADR の本文と照合した（人のレビューは未了）。team 規約の例外（案）を含む | 案（範囲・CI と AWS の線引きの決定を除く。規約の例外は未承認） | [ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md) |
| ST1〜ST9 | 技術スタックの判断（JSON は circe、接続プールは HikariCP など） | ST9（ローカル開発だけ H2 の PostgreSQL モード）は**決定済み**。ST1〜ST8 は案 | [技術スタック](./tech-stack.md) |
| SD1〜SD7 | ドメインの判断（`enum` による状態、`Evolution`、`ValidatedNec` による検証、`Long` など） | SD2 のうち「`Ignored` で止める」は**決定済み**。ほかは案 | [ドメインモデル](./domain-model.md) |
| SBD1〜SBD11 | バックエンドの判断（`Left` での明示 ROLLBACK、`Supervisor`、`Kleisli` による文脈など）。SBD7・SBD11 は ST6・ST8 の参照 | 案 | [バックエンドアーキテクチャ](./architecture-backend.md) |
| SI1〜SI5 | インフラの判断（配布物の作り方は 3 案で未決、タスクサイズの初期案、SIGTERM の終了コードは未確認、Terraform と CI の Scala 版専用化） | 案。Terraform・デプロイ用ワークフローの専用化は、範囲の決定により後回し。検証用の CI（`check` ジョブ 1 本）は U1 に含む | [インフラストラクチャ](./architecture-infrastructure.md) |
| SF1〜SF3 | フロントの判断（共有 web の再利用、起動案内の差し替え、`@ui` による同等性の確認） | 案 | [フロントエンドアーキテクチャ](./architecture-frontend.md) |
| SU1〜SU2 | UI 設計は複製しない、契約の逸脱はバックエンドで直す | 案 | [UI 設計](./ui-design.md) |
| STT1〜STT4 | テスト戦略の判断。カバレッジは、行率を scoverage の XML から算出する案 C を第一とする（STT2） | STT2 の「案 C を第一」は**決定済み**。しきい値の数値と STT1・STT3・STT4 は案 | [テスト戦略](./test-strategy.md) |
| SN1〜SN3 | 非機能要件の判断 | NF-P2 は p95 4 秒に揃えることが**決定済み**。ほかは案 | [非機能要件](./non-functional.md) |
| NF-SC1〜 | Scala 固有の非機能要件の追加（`NF-C` は容量用で使用済みのため、この接頭辞にした） | 案（未承認） | [非機能要件](./non-functional.md) |

判断 ID の接頭辞の規則（SD・SBD・ST・SI・SF・SU・STT・SN・NF-SC）と、同じ判断を 2 つの ID で持たない規則（JSON は ST6、接続プールは ST8 が正本）は、[ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md) の「決定」にあります（AI の案）。

## 承認待ちの判断

承認者はすべてユーザーです。時期は未定です。

| # | 判断 | 承認の範囲 | 備考 |
| :--- | :--- | :--- | :--- |
| 1 | ADR-001 の引き継ぎ表（20 行。AI が本文と照合したもので、人のレビューは未了）、Intent、成功の測り方の数値目標、**team 規約の例外（ステージングへの自動反映を持たない間。期間・解除の条件を含む案）** | [ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md) | 数値は B1 の計画で承認を得る（案）。Kotlin 版で未承認の ADR を暗黙に承認することにはならない。規約の例外は、承認するか、AWS・デプロイを U1 に含めるかをユーザーが決める |
| 2 | H2 の依存の導入、H2 の版の確認結果、動作範囲 | ST9 | 採用そのものは決定済み。動作範囲は B1 の最初に実測して確定する |
| 3 | ST1〜ST8（特に circe の ST6、doobie-hikari の ST8）、Scala の版（3.7 系に据え置き）、doobie RC12 | [技術スタック](./tech-stack.md) | 新規の依存は導入時に承認を得る |
| 4 | SD1〜SD7（特に `Evolution` の型と版の持ち方、`Long`） | [ドメインモデル](./domain-model.md) | 「`Ignored` で止める」は決定済み |
| 5 | SBD1〜SBD11（特に SBD2 の `Left` での ROLLBACK、SBD3、SBD4）と、レビューの直し方の案（H4 の `Tx.run`、再レビューの N-H1 許す組の表、N-H2 `ProjectionLock` の `ConnectionIO` 変換、N-H3 `.transact(` の許可する入口の一覧、`ChangeNotifier`） | [バックエンドアーキテクチャ](./architecture-backend.md)、[ドメインモデル](./domain-model.md) | いずれも AI の案で未承認。N-H2・N-H3 は B1 の最初に実測して確定する |
| 6 | SI1〜SI5、SF1〜SF3、SU1〜SU2 | 各文書 | 検証用の CI（`check` ジョブ 1 本）は U1 に含める（決定）。AWS・デプロイ用ワークフロー・ステージングは後回し |
| 7 | STT1〜STT4、カバレッジのしきい値の数値 | [テスト戦略](./test-strategy.md) | 案 C（行率の算出）が成り立つかは B1 で確かめる。`domain` の文 97% は目安（決定）で、ゲートにするかは B1 の実測後に決める。共有の `apps/beer-game-features/` の運用の承認を含む |
| 8 | SN1〜SN3、NF-SC1〜（接頭辞を含む） | [非機能要件](./non-functional.md) | NF-P2 は決定済み。SIGTERM の終了コードなどは未決 |
| 9 | 生きたドキュメントの生成方式（ADR-018 の置き換え）と公開先 | [ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md)、[テスト戦略](./test-strategy.md) | コード着手後に方式を決める |

## 未確認の前提

- 確認した事項と未確認の事項の状態は、[技術スタックの確認状況の一覧](./tech-stack.md#確認状況の一覧) を唯一の正本とします。ここには状態を複製しません。
- 一覧の根拠は実測の記録（[データモデル](./data-model.md) の検証、[テスト戦略](./test-strategy.md) の確認した事項）で、一覧を直すときは根拠も直します（案）。
- 設計時の検証は、ドメイン断片のコンパイルと munit に加え、K5・K8〜K17 は実 DB と道具で確認した記録があります（成立・不成立の別と詳細は一覧）。一覧になお未確認の項目があり、B1 の最初のスライドで、切断・再送・SIGTERM を含めて確かめます。
- 実装（`apps/beer-game-scala/`）はまだありません。生成物（`generated/`）は、コード着手後に方式を決めます。

## 補足

- 実ドキュメントを追加したら、この一覧を更新します。
- 設計書のレビュー結果は、[設計書レビュー（2026-11-25）](../../review/beer-game-scala/design_review_20261125.md) にあります。「高」の指摘への対応は、上記の決定以外は AI の案です。再レビュー結果は [設計書の再レビュー（2026-11-25）](../../review/beer-game-scala/design_rereview_20261125.md) にあります。
