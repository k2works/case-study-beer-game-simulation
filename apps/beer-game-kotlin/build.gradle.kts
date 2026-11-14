import io.gitlab.arturbosch.detekt.extensions.DetektExtension
import org.gradle.api.tasks.testing.Test
import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension
import org.jlleitschuh.gradle.ktlint.KtlintExtension

plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.kover) apply false
    alias(libs.plugins.detekt) apply false
    alias(libs.plugins.ktlint) apply false
}

val ktlintVersion = libs.versions.ktlint.tool.get()
val kotestRunner = libs.kotest.runner
val kotestAssertions = libs.kotest.assertions

// すべてのモジュールに共通の設定。コンパイラの警告はエラー、静的解析の違反は 0 件、Kover は test を計測する。
subprojects {
    apply(plugin = "org.jetbrains.kotlin.jvm")
    apply(plugin = "org.jetbrains.kotlinx.kover")
    apply(plugin = "io.gitlab.arturbosch.detekt")
    apply(plugin = "org.jlleitschuh.gradle.ktlint")

    group = "beergame"

    repositories {
        mavenCentral()
    }

    extensions.configure<KotlinJvmProjectExtension> {
        compilerOptions {
            allWarningsAsErrors.set(true)
        }
    }

    extensions.configure<DetektExtension> {
        buildUponDefaultConfig = true
        allRules = false
        // maxIssues: 0 は config 側。ベースラインは作らない。
        config.setFrom(rootProject.file("config/detekt/detekt.yml"))
        parallel = true
    }

    extensions.configure<KtlintExtension> {
        version.set(ktlintVersion)
    }

    dependencies {
        "testImplementation"(kotestRunner)
        "testImplementation"(kotestAssertions)
        "testRuntimeOnly"("org.junit.platform:junit-platform-launcher")
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
    }

    // 型解決つきの detekt（ForbiddenMethodCall が要る）も check に含める。
    tasks.matching { it.name == "check" }.configureEach {
        dependsOn("detektMain", "detektTest")
    }
}

// detekt 1.23.8 は、同梱の Kotlin コンパイラが JDK 25 のバージョン文字列（25.0.2）を解釈できず、
// JDK 25 の上では実行できない（IllegalArgumentException: 25.0.2）。--jvm-target も 22 までしか受け付けない。
// JDK 22 以下で Gradle を動かすときだけ有効にする。CI は JDK 21 の専用ジョブで実行する。B2 で代替を判断する。
val detektSupported = JavaVersion.current() <= JavaVersion.VERSION_22

if (!detektSupported) {
    logger.warn(
        "警告: detekt 1.23.8 は JDK ${JavaVersion.current()} では動かないため、detekt を無効にしています。" +
            "JDK 21 で ./gradlew detektMain detektTest を実行してください。",
    )
}

subprojects {
    tasks.withType<io.gitlab.arturbosch.detekt.Detekt>().configureEach {
        jvmTarget = "22"
        enabled = detektSupported
    }
}

// ---- PMD（関数型ルールの XPath の検査）----
// PMD の Gradle プラグイン（pmd）は Java 用なので使わず、PMD のコマンドライン（PmdCli）を JavaExec で実行する。
// Kotlin の解析は pmd-kotlin が担う。ルールは config/pmd/ に置く（層ごとにルールセットを分ける。@Suppress は使わない）。
val pmdTool by configurations.creating

repositories {
    mavenCentral()
}

dependencies {
    pmdTool(libs.pmd.cli)
    pmdTool(libs.pmd.kotlin)
}

val pmdReportDir = layout.buildDirectory.dir("pmd")

// fixture のテスト: 違反するコードとしないコードを並べた fixture に fp-kotlin-rules.xml を実行し、
// 期待した「行 ルール名」だけが報告される（過不足なし）ことを検査する。処理エラー・ルールの設定の誤りも失敗にする。
tasks.register<JavaExec>("pmdFixtureTest") {
    group = "verification"
    description = "PMD の関数型ルールを fixture に実行し、期待どおりの違反だけが報告されることを検査する。"
    classpath = pmdTool
    mainClass.set("net.sourceforge.pmd.cli.PmdCli")
    workingDir = rootDir
    isIgnoreExitValue = true
    val report = pmdReportDir.map { it.file("fixture.xml") }
    args(
        "check", "-d", "config/pmd/fixtures", "-R", "config/pmd/fp-kotlin-rules.xml",
        "-f", "xml", "-r", report.get().asFile.path, "--no-cache", "--no-progress",
    )
    doFirst { report.get().asFile.parentFile.mkdirs() }
    doLast {
        val doc = javax.xml.parsers.DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(report.get().asFile)
        fun texts(tag: String, attr: String) =
            (0 until doc.getElementsByTagName(tag).length).map {
                (doc.getElementsByTagName(tag).item(it) as org.w3c.dom.Element).getAttribute(attr)
            }
        val problems = texts("error", "msg") + texts("configerror", "msg")
        check(problems.isEmpty()) { "PMD の処理エラーまたはルールの設定の誤り: $problems" }
        val violations = doc.getElementsByTagName("violation")
        val actual = (0 until violations.length).map {
            val e = violations.item(it) as org.w3c.dom.Element
            "${e.getAttribute("beginline")} ${e.getAttribute("rule")}"
        }.sorted()
        val expected = rootDir.resolve("config/pmd/fixtures/expected.txt").readLines()
            .filter { it.isNotBlank() && !it.startsWith("#") }.sorted()
        check(actual == expected) {
            "fixture の違反が期待と一致しない。\n期待 ${expected.size} 件: $expected\n実際 ${actual.size} 件: $actual"
        }
        logger.lifecycle("pmdFixtureTest: 期待どおり ${actual.size} 件")
    }
}

// 層ごとの検査。ルールセットは層ごとに分け、外すルールはルールセットの中で理由とともに明示する。
// 違反が 1 件でもあれば失敗する（PMD の終了コード 4）。ベースラインは使わない。
fun registerPmd(taskName: String, ruleset: String, dirs: List<String>) =
    tasks.register<JavaExec>(taskName) {
        group = "verification"
        description = "PMD を $ruleset で実行する（違反 0 件）。"
        classpath = pmdTool
        mainClass.set("net.sourceforge.pmd.cli.PmdCli")
        workingDir = rootDir
        val existing = dirs.filter { rootDir.resolve(it).isDirectory }
        inputs.files(existing.map { rootDir.resolve(it) })
        inputs.dir(rootDir.resolve("config/pmd"))
        args(
            "check", "-d", existing.joinToString(","), "-R", "config/pmd/$ruleset",
            "-f", "text", "--no-cache", "--no-progress",
        )
    }

val modules = listOf("domain", "application", "adapter-persistence", "adapter-http", "app")
val pmdDomainApp = registerPmd("pmdDomainApplication", "ruleset-domain.xml", listOf("domain/src/main", "application/src/main"))
val pmdAdapter = registerPmd("pmdAdapter", "ruleset-adapter.xml", listOf("adapter-persistence/src/main", "adapter-http/src/main"))
val pmdMainApp = registerPmd("pmdMain", "ruleset-main.xml", listOf("app/src/main"))
val pmdTestCode = registerPmd(
    "pmdTest",
    "ruleset-test.xml",
    modules.flatMap { m -> listOf("test", "integrationTest", "acceptanceTest").map { "$m/src/$it" } },
)

tasks.register("pmd") {
    group = "verification"
    description = "PMD の fixture のテストと、層ごとの検査をすべて実行する。"
    dependsOn("pmdFixtureTest", pmdDomainApp, pmdAdapter, pmdMainApp, pmdTestCode)
}

// 各モジュールの check にも組み込み、ローカルでも CI と同じタスクで再現できるようにする。
subprojects {
    tasks.matching { it.name == "check" }.configureEach {
        dependsOn(rootProject.tasks.named("pmd"))
    }
}
