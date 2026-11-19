package beergame.domain

/**
 * サイトシーイング・マップ 1 枚の定義。[map] は注釈 `@KeyLandmark` の `map`、[file] は `generated/` の中のファイル名、
 * [categories] は区分の名前と意味（この順に並べる。注釈の `layer` は、この名前のどれかにする）。
 * [withDependencies] が true のマップは、ビルドの定義から導いたモジュールの依存の向きを載せる（アーキテクチャのマップだけ）。
 */
internal data class MapDoc(
    val map: String,
    val file: String,
    val title: String,
    val summary: String,
    val description: String,
    val categories: List<Pair<String, String>>,
    val withDependencies: Boolean = false,
)
