// Ktor のルート。application と domain に依存する。
dependencies {
    api(project(":application"))
    api(project(":domain"))
    implementation(libs.ktor.server.core)
    implementation(libs.serialization.json)
}
