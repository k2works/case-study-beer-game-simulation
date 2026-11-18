plugins {
    application
}

// ローカルの起動: `APP_ENV=local DB_KIND=h2 ./gradlew :app:run`（引数で起動モード。既定は api）
application {
    mainClass.set("beergame.app.MainKt")
}

// 配布（installDist・distZip）から H2 のドライバを外す。H2 はローカル開発専用（ADR-014）で、本番のイメージに含めない
// （architecture-infrastructure.md「二重の防御」。起動時の検査と合わせる）。`:app:run` と各テストの実行時の依存には残る。
val excludedFromDistribution = Regex("^h2-.*\\.jar$")
tasks.named<CreateStartScripts>("startScripts") {
    classpath = classpath?.filter { !excludedFromDistribution.matches(it.name) }
}
distributions {
    main {
        contents {
            exclude("h2-*.jar")
        }
    }
}

// 組み立てと起動。全モジュールに依存する。
dependencies {
    implementation(project(":domain"))
    implementation(project(":application"))
    implementation(project(":adapter-persistence"))
    implementation(project(":adapter-http"))
    implementation(libs.ktor.server.netty)
    implementation(libs.hikari)
    implementation(libs.coroutines.core)
    implementation(libs.serialization.json)
    runtimeOnly(libs.logback.classic)

    testImplementation(libs.ktor.server.test.host)
    // API の契約テスト（contracts/openapi.yaml と実装の一致の検査）だけで使う。本番の依存には入れない。
    // 実物の永続化（H2）と全経路の組み立てがあるのは app だけなので、契約テストは app の test に置く。
    testImplementation(libs.json.schema.validator)
}

// 契約テスト（beergame.app.contract）は、仕様 contracts/openapi.yaml を読む。仕様を変えたら test を再実行する（入力に加える）。
// domain の code の走査は、domain のクラスが classpath にあるため、domain の変更でも再実行される。
tasks.named<Test>("test") {
    inputs.file(rootProject.file("contracts/openapi.yaml")).withPropertyName("openApiSpec")
}

// acceptanceTest: 受け入れ（Cucumber-JVM。@api のシナリオ）。ADR-012。
// 日本語 Gherkin のフィーチャーファイルは、リポジトリの features/ に 1 か所で置き、Cucumber-JS（web/）と共有する。
// Cucumber-JVM 8.0.4 は JUnit 6.1.3 を要求する。unit の Kotest（JUnit 5.13.4）と混ざらないよう、
// test のクラスパスを継承せず、acceptanceTest だけ独立したクラスパスにする。
// B1 の Step 11 で、main（全モジュールの組み立て）に依存させた。ステップ定義は窓口（GamePlayApi）から、
// 実物の Ktor サーバー（application と adapter-persistence を本番と同じ組み立てで通す）を HTTP で呼ぶ。
// compileClasspath と runtimeClasspath に sourceSets.main の output を足し、implementation と runtimeOnly を extendsFrom で継ぐ。
val acceptanceTest: SourceSet by sourceSets.creating {
    resources.srcDir(rootProject.file("features"))
    compileClasspath += sourceSets.main.get().output
    runtimeClasspath += sourceSets.main.get().output
}

configurations[acceptanceTest.implementationConfigurationName].extendsFrom(configurations.implementation.get())
configurations[acceptanceTest.runtimeOnlyConfigurationName].extendsFrom(configurations.runtimeOnly.get())

dependencies {
    "acceptanceTestImplementation"(platform(libs.junit.bom.cucumber))
    "acceptanceTestImplementation"(libs.cucumber.java)
    "acceptanceTestImplementation"(libs.cucumber.junit.platform.engine)
    "acceptanceTestImplementation"(libs.junit.platform.suite)
    "acceptanceTestImplementation"(libs.testcontainers.postgresql)
    "acceptanceTestRuntimeOnly"(libs.junit.platform.launcher.cucumber)
}

// 受け入れの正は PostgreSQL（Testcontainers の postgres:18-alpine）。H2 はローカル開発の経路の確認（ADR-014）。
// 実行する DB は、システムプロパティ acceptance.db（postgres または h2）で選ぶ。
fun registerAcceptance(
    taskName: String,
    database: String,
    summary: String,
) = tasks.register<Test>(taskName) {
    description = "受け入れ（Cucumber-JVM）の @api シナリオを $summary で実行する。Undefined・Pending のステップがあれば失敗する。"
    group = "verification"
    testClassesDirs = acceptanceTest.output.classesDirs
    classpath = acceptanceTest.runtimeClasspath
    shouldRunAfter(tasks.test)
    systemProperty("acceptance.db", database)
    // 失敗したシナリオを黙って成功にしない。出力にシナリオごとの結果を出す。
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
    }
}

registerAcceptance("acceptanceTest", "postgres", "実 PostgreSQL（Testcontainers）の上で")
registerAcceptance("acceptanceTestH2", "h2", "H2（PostgreSQL モード）の上で")

// integrationTest: 実 PostgreSQL（Testcontainers）を通す、HTTP の最小の統合。test の出力（試験の道具）も使う。
val integrationTest: SourceSet by sourceSets.creating {
    compileClasspath += sourceSets.main.get().output + sourceSets.test.get().output
    runtimeClasspath += sourceSets.main.get().output + sourceSets.test.get().output
}

configurations[integrationTest.implementationConfigurationName].extendsFrom(configurations.testImplementation.get())
configurations[integrationTest.runtimeOnlyConfigurationName].extendsFrom(configurations.testRuntimeOnly.get())

dependencies {
    "integrationTestImplementation"(libs.testcontainers.postgresql)
}

tasks.register<Test>("integrationTest") {
    description = "実 PostgreSQL（Testcontainers）を通す HTTP の統合テストを実行する。"
    group = "verification"
    testClassesDirs = integrationTest.output.classesDirs
    classpath = integrationTest.runtimeClasspath
    shouldRunAfter(tasks.test)
    // 計測の規模の切り替え（環境変数 BEERGAME_MEASURE）を、テストの JVM へ渡す（Gradle の入力にして、変えたら再実行する）。
    inputs.property("beergameMeasure", providers.environmentVariable("BEERGAME_MEASURE").orElse(""))
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
