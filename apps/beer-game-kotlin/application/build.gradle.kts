// application は domain にだけ依存する。adapter-* と、Ktor・JDBC・ログの基盤には依存しない。
dependencies {
    api(project(":domain"))
    // ChangeNotifier が Flow を、EventStore が suspend を公開するので api にする。
    api(libs.coroutines.core)
}
