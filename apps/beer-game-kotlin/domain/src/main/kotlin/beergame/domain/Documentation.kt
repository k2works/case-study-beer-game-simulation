package beergame.domain

/*
 * Living Documentation の注釈の語彙（B5 Step 8.4。開発戦略の「注釈の語彙と生成の仕組み」）。
 * 型に付けた注釈から、用語集とイベント一覧を生成する（`docs/design/beer-game-kotlin/generated/`。手で複製しない）。
 * 注釈は実行時まで残るだけで、業務の振る舞いには関わらない（標準ライブラリだけ。domain の依存の規約を守る）。
 * 生成と検査は domain の試験 `LivingDocumentationSpec`（`./gradlew :domain:generateLivingDocs` で再生成）。
 */

/**
 * ユビキタス言語の 1 項目。型に付けると、用語集（生成物）の 1 行になる。
 * 付ける型は、これから書くコードと、B5 で足した概念から始める（既存コードへの一括適用はしない）。
 *
 * @property name 業務の言葉（日本語）。用語集の中で一意
 * @property definition 業務の言葉での定義
 * @property source 定義の出典（受入条件、設計書の節など）
 */
@Target(AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
@MustBeDocumented
annotation class Term(
    val name: String,
    val definition: String,
    val source: String,
)

/**
 * ドメインの中核の概念（Highlighted Core）。付けると、コアのハイライト（生成物）に載る。
 * 動的キュレーションの選択基準で、名前や場所を名指しせず、注釈で選ぶ。付けるのは**主要な概念だけ**（上限 10。いまは 5）。
 * 設計書の「境界付けられたコンテキストの分類」で「中核」とされたコンテキストの概念に限る（補完・一般のものには付けない。試験が検出する）。
 *
 * @property context 設計書の表のコンテキスト名（「シミュレーション計算」「進行（プレイ）」）。表の名前と一致させる
 * @property description なぜ核心か（コードを読むだけでは分からない、意図と背景）。読み手は、新しく参加する開発者
 */
@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION)
@Retention(AnnotationRetention.RUNTIME)
@MustBeDocumented
annotation class CoreConcept(
    val context: String,
    val description: String,
)

/**
 * ドメインイベントの 1 項目。イベント（`GameEvent`・`SessionEvent` の部分型）に付けると、イベント一覧（生成物）の 1 行になる。
 * ストリーム、ペイロードの項目、購読する投影は、型とソースから導くので、ここには書かない。
 *
 * @property id 設計書（ドメインモデルの「ドメインイベント」の表）の ID（`EV-G01`、`EV-S01` など）。一覧と設計書の不一致は試験が検出する
 * @property trigger 発生する条件（コマンドと前提）
 */
@Target(AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
@MustBeDocumented
annotation class EventSpec(
    val id: String,
    val trigger: String,
)
