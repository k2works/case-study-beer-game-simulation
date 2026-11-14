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
