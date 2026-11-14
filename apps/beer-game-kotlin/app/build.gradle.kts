// 組み立てと起動。全モジュールに依存する。
dependencies {
    implementation(project(":domain"))
    implementation(project(":application"))
    implementation(project(":adapter-persistence"))
    implementation(project(":adapter-http"))
    implementation(libs.ktor.server.netty)
    runtimeOnly(libs.logback.classic)
}
