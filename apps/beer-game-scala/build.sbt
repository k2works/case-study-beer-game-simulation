// beer-game-scala（ビールゲームシミュレーション Scala 版）
// 層の境界は sbt のプロジェクトと dependsOn で守る（docs/design/beer-game-scala/architecture-backend.md）。
// 静的解析は B1 の最初に設定し、全コードで違反 0 件・ベースラインなし・抑制なし
// （docs/development/beer-game-scala/development_strategy.md の「静的解析とルール設定」）。

ThisBuild / scalaVersion := "3.7.4"
ThisBuild / organization := "bgs"
ThisBuild / version := "0.1.0-SNAPSHOT"

val catsVersion = "2.13.0"
val munitVersion = "1.3.6"

// ガイド（関数型プログラミングガイド_Scala編 §9.4）の 13 個の Wart
val strictWarts = Seq(
  Wart.Var,
  Wart.Null,
  Wart.Throw,
  Wart.OptionPartial,
  Wart.TryPartial,
  Wart.EitherProjectionPartial,
  Wart.IterableOps,
  Wart.AsInstanceOf,
  Wart.IsInstanceOf,
  Wart.Return,
  Wart.MutableDataStructures,
  Wart.TripleQuestionMark,
  Wart.DefaultArguments
)

lazy val commonSettings = Seq(
  scalacOptions ++= Seq(
    "-deprecation",
    "-feature",
    "-Werror",
    "-Wunused:all",
    "-Wvalue-discard",
    "-Wnonunit-statement"
  ),
  wartremoverErrors := strictWarts,
  // テストのソースには WartRemover を適用しない（ガイド §9.4「テストには適用しない」）。
  // Test / wartremoverErrors := Seq.empty では外れない（確認した事項 10）。
  Test / scalacOptions ~= (_.filterNot(_.startsWith("-P:wartremover"))),
  libraryDependencies ++= Seq(
    "org.scalameta" %% "munit" % munitVersion % Test
  ),
  Test / fork := true
)

lazy val domain = (project in file("domain"))
  .settings(commonSettings)
  .settings(
    libraryDependencies += "org.typelevel" %% "cats-core" % catsVersion
  )

lazy val application = (project in file("application"))
  .dependsOn(domain)
  .settings(commonSettings)

lazy val adapterPersistence = (project in file("adapter-persistence"))
  .dependsOn(application)
  .settings(commonSettings)

lazy val adapterHttp = (project in file("adapter-http"))
  .dependsOn(application)
  .settings(commonSettings)

lazy val app = (project in file("app"))
  .dependsOn(adapterHttp, adapterPersistence)
  .settings(commonSettings)

lazy val acceptance = (project in file("acceptance"))
  .dependsOn(app)
  .settings(commonSettings)

// 規則の確認用（ルートの集約に含めない）。違反するコードを置き、期待件数を scripts/check-rules.sh で確かめる。
lazy val rulesFixtureWarts = (project in file("rules-fixture-warts"))
  .settings(commonSettings)

lazy val rulesFixtureScalafix = (project in file("rules-fixture-scalafix"))
  .settings(commonSettings)

lazy val root = (project in file("."))
  .aggregate(domain, application, adapterPersistence, adapterHttp, app, acceptance, coverageTool)
  .settings(
    name := "beer-game-scala",
    publish / skip := true
  )

// scoverage の XML から行率を算出する道具（案 C。ガイドとは別に、team の「行 80%」の判定に使う）。
lazy val coverageTool = (project in file("tools/line-coverage"))
  .settings(commonSettings)
  .settings(
    libraryDependencies ++= Seq(
      "org.scala-lang.modules" %% "scala-xml" % "2.5.0",
      "org.typelevel" %% "cats-effect" % "3.7.1"
    )
  )
