plugins {
    alias(libs.plugins.kotlin.serialization)
}

// Ktor のルート。application と domain に依存する。JDBC には依存しない（永続化は app が組み立てて渡す）。
dependencies {
    api(project(":application"))
    api(project(":domain"))
    api(libs.ktor.server.core)
    implementation(libs.ktor.server.status.pages)
    implementation(libs.serialization.json)
    implementation(libs.slf4j.api)

    testImplementation(libs.ktor.server.test.host)
}
