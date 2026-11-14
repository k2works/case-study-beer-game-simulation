// JDBC による永続化。application と domain に依存する。
dependencies {
    api(project(":application"))
    api(project(":domain"))
    implementation(libs.hikari)
    implementation(libs.flyway.core)
    implementation(libs.flyway.postgresql)
    runtimeOnly(libs.postgresql)
    runtimeOnly(libs.h2)
}

// integrationTest: 実 PostgreSQL（Testcontainers）を使う試験の置き場。B1 の Step 2 では試験を置かない。
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
}
