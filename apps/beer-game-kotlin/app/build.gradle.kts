// 組み立てと起動。全モジュールに依存する。
dependencies {
    implementation(project(":domain"))
    implementation(project(":application"))
    implementation(project(":adapter-persistence"))
    implementation(project(":adapter-http"))
    implementation(libs.ktor.server.netty)
    runtimeOnly(libs.logback.classic)
}

// acceptanceTest: 受け入れ（Cucumber-JVM。@api のシナリオ）。ADR-012。
// 日本語 Gherkin のフィーチャーファイルは、リポジトリの features/ に 1 か所で置き、Cucumber-JS（web/）と共有する。
// Cucumber-JVM 8.0.4 は JUnit 6.1.3 を要求する。unit の Kotest（JUnit 5.13.4）と混ざらないよう、
// test のクラスパスを継承せず、acceptanceTest だけ独立したクラスパスにする。
// B1 の Step 3 では、内側（domain・application・adapter）がまだ無いので、ステップ定義は窓口（GamePlayApi）だけを呼ぶ。
// そのため、acceptanceTest は main（全モジュールの組み立て）に依存しない。Step 9〜11 で、実物の窓口に差し替えるときに、
// compileClasspath と runtimeClasspath に sourceSets.main の output を足し、implementation と runtimeOnly を extendsFrom で継ぐ。
val acceptanceTest: SourceSet by sourceSets.creating {
    resources.srcDir(rootProject.file("features"))
}

dependencies {
    "acceptanceTestImplementation"(platform(libs.junit.bom.cucumber))
    "acceptanceTestImplementation"(libs.cucumber.java)
    "acceptanceTestImplementation"(libs.cucumber.junit.platform.engine)
    "acceptanceTestImplementation"(libs.junit.platform.suite)
    "acceptanceTestRuntimeOnly"(libs.junit.platform.launcher.cucumber)
}

tasks.register<Test>("acceptanceTest") {
    description = "受け入れ（Cucumber-JVM）の @api シナリオを実行する。Undefined・Pending のステップがあれば失敗する。"
    group = "verification"
    testClassesDirs = acceptanceTest.output.classesDirs
    classpath = acceptanceTest.runtimeClasspath
    shouldRunAfter(tasks.test)
    // 失敗したシナリオを黙って成功にしない。出力にシナリオごとの結果を出す。
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
    }
}
