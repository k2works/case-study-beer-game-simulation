import io.gitlab.arturbosch.detekt.extensions.DetektExtension

// domain は Kotlin 標準ライブラリと Arrow Core だけに依存する。他のモジュールにも依存しない。
dependencies {
    api(libs.arrow.core)
    // プロパティベーステスト用（テストだけ。本番の依存の検査の対象外。版は kotest に揃える）。
    testImplementation("io.kotest:kotest-property:${libs.versions.kotest.get()}")
}

extensions.configure<DetektExtension> {
    config.setFrom(
        rootProject.file("config/detekt/detekt.yml"),
        rootProject.file("config/detekt/detekt-domain.yml"),
    )
}

// domain の行のカバレッジのゲート。設計の目標は 100% だが、コンパイラ生成のコード（value class のプライマリコンストラクタの
// プロパティ 9 行、object Projections のプロパティの getter 9 行、ほか）が未到達で、実測は 97.5%（784/804）。
// 下限 97% は、実測に基づく暫定の値（閾値を下げて通すためではなく、現状より悪化させないため）。100% にするか、
// 生成コードの除外か閾値の見直しかは、人が決める（bolt_2_plan.md の Step 2 の結果）。
kover {
    reports {
        verify {
            rule("domain の行（目標 100%。暫定の下限 97%）") {
                bound {
                    minValue = 97
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
