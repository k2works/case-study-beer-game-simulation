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
    libraryDependencies += "org.typelevel" %% "cats-core" % catsVersion,
    libraryDependencies ++= Seq(
      "org.scalameta" %% "munit-scalacheck" % "1.3.1" % Test,
      "org.scalacheck" %% "scalacheck" % "1.20.0" % Test,
      "org.typelevel" %% "cats-laws" % catsVersion % Test,
      "org.typelevel" %% "discipline-munit" % "2.0.0" % Test
    )
  )

val doobieVersion = "1.0.0-RC12"
val circeVersion = "0.14.17"
val flywayVersion = "13.12.2"

lazy val application = (project in file("application"))
  .dependsOn(domain)
  .settings(commonSettings)
  .settings(
    libraryDependencies ++= Seq(
      "org.typelevel" %% "cats-effect" % "3.7.1",
      "org.tpolecat" %% "doobie-core" % doobieVersion
    )
  )

lazy val adapterPersistence = (project in file("adapter-persistence"))
  .dependsOn(application, domain % "test->test")
  .settings(commonSettings)
  .settings(
    // トランザクションの入口を書いてよい唯一のファイル。Scalafix の検査から、このファイルだけを除く（scalafix:off は使わない）。
    Compile / scalafix / unmanagedSources :=
      (Compile / unmanagedSources).value.filterNot(_.getName == "Transactions.scala"),
    // `check` ジョブは、Docker を要する統合テスト（タグ Integration）を除外する。`integration` ジョブが実行する。
    Test / testOptions ++= {
      if (sys.env.contains("BGS_SKIP_INTEGRATION"))
        Seq(Tests.Argument(TestFrameworks.MUnit, "--exclude-tags=Integration"))
      else Nil
    }
  )
  .settings(
    libraryDependencies ++= Seq(
      "org.tpolecat" %% "doobie-postgres" % doobieVersion,
      "org.postgresql" % "postgresql" % "42.7.15",
      "com.h2database" % "h2" % "2.5.252",
      "org.flywaydb" % "flyway-core" % flywayVersion,
      "org.flywaydb" % "flyway-database-postgresql" % flywayVersion,
      "io.circe" %% "circe-core" % circeVersion,
      "io.circe" %% "circe-generic" % circeVersion,
      "io.circe" %% "circe-parser" % circeVersion,
      "org.typelevel" %% "munit-cats-effect" % "2.2.1" % Test,
      "com.dimafeng" %% "testcontainers-scala-postgresql" % "0.44.1" % Test,
      "com.dimafeng" %% "testcontainers-scala-munit" % "0.44.1" % Test
    )
  )

val http4sVersion = "0.23.39"

lazy val adapterHttp = (project in file("adapter-http"))
  .dependsOn(application)
  .settings(commonSettings)
  .settings(
    libraryDependencies ++= Seq(
      "org.http4s" %% "http4s-dsl" % http4sVersion,
      "org.http4s" %% "http4s-circe" % http4sVersion,
      "org.http4s" %% "http4s-ember-server" % http4sVersion,
      "io.circe" %% "circe-core" % circeVersion,
      "io.circe" %% "circe-parser" % circeVersion
    )
  )

lazy val app = (project in file("app"))
  .dependsOn(adapterHttp, adapterPersistence, domain % "test->test")
  .settings(commonSettings)
  .settings(
    libraryDependencies += "org.typelevel" %% "munit-cats-effect" % "2.2.1" % Test
  )

lazy val acceptance = (project in file("acceptance"))
  .dependsOn(app)
  .settings(commonSettings)
  .settings(
    libraryDependencies ++= Seq(
      "io.cucumber" %% "cucumber-scala" % "9.3.0" % Test,
      "org.http4s" %% "http4s-circe" % http4sVersion % Test,
      "io.circe" %% "circe-parser" % circeVersion % Test
    ),
    // 境界（IO を実行するステップ定義と実行器）は、unsafeRun の禁止だけを外した設定を使う。
    scalafixConfig := Some(file(".scalafix-boundary.conf")),
    // 受け入れは `sbt test` に載せず、専用のコマンド（scripts/acceptance.sh）で実行する（ST7）。
    Test / test := {}
  )

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
