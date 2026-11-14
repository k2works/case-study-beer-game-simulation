// application は domain にだけ依存する。adapter-* と、Ktor・JDBC・ログの基盤には依存しない。
dependencies {
    api(project(":domain"))
    implementation(libs.coroutines.core)
}
