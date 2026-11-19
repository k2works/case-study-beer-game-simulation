import org.gradle.api.tasks.testing.logging.TestExceptionFormat

plugins {
    alias(libs.plugins.kotlin.serialization)
}

// JDBC による永続化。application と domain に依存する。
dependencies {
    api(project(":application"))
    api(project(":domain"))
    implementation(libs.coroutines.core)
    implementation(libs.serialization.json)
    implementation(libs.hikari)
    implementation(libs.flyway.core)
    implementation(libs.flyway.postgresql)
    // PSQLException の制約名のフィールド（serverErrorMessage.constraint）を読むため、コンパイル時にも要る。
    implementation(libs.postgresql)
    runtimeOnly(libs.h2)
}

// integrationTest: 実 PostgreSQL（Testcontainers）を使う試験の置き場。test の出力（共有の契約テスト）も使う。
val integrationTest: SourceSet by sourceSets.creating {
    compileClasspath += sourceSets.main.get().output + sourceSets.test.get().output
    runtimeClasspath += sourceSets.main.get().output + sourceSets.test.get().output
}

configurations[integrationTest.implementationConfigurationName].extendsFrom(configurations.testImplementation.get())
configurations[integrationTest.runtimeOnlyConfigurationName].extendsFrom(configurations.testRuntimeOnly.get())

dependencies {
    "integrationTestImplementation"(libs.testcontainers.postgresql)
    "integrationTestRuntimeOnly"(libs.postgresql)
}

tasks.register<Test>("integrationTest") {
    description = "実 PostgreSQL（Testcontainers）を使う統合テストを実行する。"
    group = "verification"
    testClassesDirs = integrationTest.output.classesDirs
    classpath = integrationTest.runtimeClasspath
    shouldRunAfter(tasks.test)
    testLogging {
        events("failed")
        exceptionFormat = TestExceptionFormat.FULL
    }
}
