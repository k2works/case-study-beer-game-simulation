import io.gitlab.arturbosch.detekt.extensions.DetektExtension

// domain は Kotlin 標準ライブラリと Arrow Core だけに依存する。他のモジュールにも依存しない。
dependencies {
    api(libs.arrow.core)
    // プロパティベーステスト用（テストだけ。本番の依存の検査の対象外。版は kotest に揃える）。
    testImplementation("io.kotest:kotest-property:${libs.versions.kotest.get()}")
}

// interface の既定メソッドを、旧 Kotlin・Java 向けの互換の `DefaultImpls`（呼ばれない生成コード）なしで出す。
// domain は同じ Kotlin のビルドからだけ使われ、互換は要らない（Actor の toRef・isFacilitatorOf の未到達の行の原因）。
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions.freeCompilerArgs.add("-jvm-default=no-compatibility")
}

// Living Documentation（B5 Step 8.4）: 注釈とソースから、用語集とイベント一覧を生成する（docs/design/beer-game-kotlin/generated/）。
// 通常の test は、コミット済みの生成物との一致を検査するだけ。この task は、同じ試験を更新モードで実行して、生成物を書き換える。
tasks.register<Test>("generateLivingDocs") {
    group = "documentation"
    description = "用語集・イベント一覧・ウォーキングスケルトンのガイドツアーを、コードの注釈とソースから生成して docs/design/beer-game-kotlin/generated/ へ書く。"
    val testSourceSet = sourceSets.named("test")
    testClassesDirs = testSourceSet.get().output.classesDirs
    classpath = testSourceSet.get().runtimeClasspath
    useJUnitPlatform()
    filter {
        includeTestsMatching("beergame.domain.LivingDocumentationSpec")
        includeTestsMatching("beergame.domain.CoreHighlightSpec")
        includeTestsMatching("beergame.domain.GuidedTourSpec")
    }
    systemProperty("beergame.docs.update", "true")
    outputs.upToDateWhen { false }
}

extensions.configure<DetektExtension> {
    config.setFrom(
        rootProject.file("config/detekt/detekt.yml"),
        rootProject.file("config/detekt/detekt-domain.yml"),
    )
}

// domain の行のカバレッジのゲート（設計の目標 100%）。除外はせず、未到達だった行（value class のボックス化した値の getter、
// object Projections の個々の投影、interface の DefaultImpls）をテストと上の設定で到達させた。
kover {
    // 生成用の task は、docs/ を書き換える。計測の対象（koverVerify が先に実行する Test）に入れない。
    currentProject {
        instrumentation {
            disabledForTestTasks.add("generateLivingDocs")
        }
    }
    reports {
        verify {
            rule("domain の行 100%") {
                bound {
                    minValue = 100
                    coverageUnits = kotlinx.kover.gradle.plugin.dsl.CoverageUnit.LINE
                    aggregationForGroup = kotlinx.kover.gradle.plugin.dsl.AggregationType.COVERED_PERCENTAGE
                }
            }
        }
    }
}

// 依存の強制: 解決された依存が、許可した group だけであることを検査する（check に含める）。
val allowedDomainGroups = setOf("org.jetbrains.kotlin", "org.jetbrains", "io.arrow-kt")

val verifyDomainDependencies =
    tasks.register("verifyDomainDependencies") {
        group = "verification"
        description = "domain の依存が Kotlin 標準と Arrow だけであることを検査する。"
        val ownGroup = project.group.toString()
        val resolved =
            listOf("runtimeClasspath", "compileClasspath").map { name ->
                configurations.named(name).map { it.incoming.resolutionResult.allComponents }
            }
        doLast {
            val violations =
                resolved
                    .flatMap { it.get() }
                    .mapNotNull { it.moduleVersion }
                    .filter { it.group !in allowedDomainGroups && it.group != ownGroup }
                    .map { "${it.group}:${it.name}:${it.version}" }
                    .distinct()
            val projects =
                resolved
                    .flatMap { it.get() }
                    .filter { it.id is ProjectComponentIdentifier && it.moduleVersion?.group == ownGroup }
                    .map { it.moduleVersion?.name }
                    .filter { it != project.name }
                    .distinct()
            check(violations.isEmpty() && projects.isEmpty()) {
                "domain の依存の違反: 許可外のライブラリ=$violations、他のモジュール=$projects"
            }
        }
    }

tasks.named("check") { dependsOn(verifyDomainDependencies) }
