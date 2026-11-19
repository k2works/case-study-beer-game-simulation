package beergame.app.contract

import java.nio.file.Files
import java.nio.file.Path

/*
 * 実装が返しうる problem+json の `code` の全体。3 つの出どころを足す。
 *   1. ドメインの `DomainError`（domain の本体のソースの `override val code` と `category`）。
 *      分類が Forbidden の誤り（`session.forbidden`、`game.forbidden`）は、資格の失敗と同じ `app.unauthorized` に写して返す
 *      （ProblemMapping.kt）ので、利用者へは出ない。仕様の列挙にも載せない。
 *   2. HTTP の層の `Codes`（`AppFailure` の写像と、守り・経路・バリデーションの code）。
 * ドメインの code を、ソースの走査で集めるのは、Kotlin の sealed の全サブクラスを列挙する道具（kotlin-reflect）を
 * 足さないため。走査の正規表現が外れて 0 件になれば、下の試験が失敗する（0 件を許さない）。
 */
internal object ErrorCodeInventory {
    private val codePattern =
        Regex(
            """override val code: String = "([a-z_.]+)"""" +
                """\s+override val category: ErrorCategory = ErrorCategory\.(\w+)""",
        )

    /** ドメインの業務の code と、その分類。 */
    fun domainCodes(domainSourceRoot: Path): Map<String, String> =
        Files
            .walk(domainSourceRoot)
            .use { paths -> paths.filter { it.toString().endsWith(".kt") }.toList() }
            .flatMap { file ->
                codePattern.findAll(Files.readString(file)).map { it.groupValues[1] to it.groupValues[2] }.toList()
            }.toMap()

    /**
     * 参加コードの失敗だけは、Forbidden の分類でも、自分の code を返す（ProblemMapping.kt の forbiddenProblem。AC1.2.2）。
     * これ以外の Forbidden は、`app.unauthorized` に写る。
     */
    private val forbiddenButReturned = setOf("game.invitation_invalid")

    /** 利用者へ返るドメインの code（Forbidden の分類は、[forbiddenButReturned] を除いて `app.unauthorized` に写るので除く）。 */
    fun domainCodesReturned(domainSourceRoot: Path): Set<String> =
        domainCodes(domainSourceRoot)
            .filter { (code, category) ->
                category != "Forbidden" ||
                    code in forbiddenButReturned
            }.keys

    /** HTTP の層の `Codes`（`beergame.http.Codes` の定数の値）。 */
    fun httpCodes(): Set<String> =
        Class
            .forName("beergame.http.Codes")
            .declaredFields
            .filter {
                java.lang.reflect.Modifier
                    .isStatic(it.modifiers) && it.type == String::class.java
            }.map { it.get(null) as String }
            .toSet()
}
