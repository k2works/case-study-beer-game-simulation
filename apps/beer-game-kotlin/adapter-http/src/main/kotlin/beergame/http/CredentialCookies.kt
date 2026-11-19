package beergame.http

import io.ktor.server.application.ApplicationCall

/*
 * 資格の Cookie の名前の解決（ADR-020）。同じブラウザの複数のタブが、別の人として操作できるようにする。
 * Cookie は、ブラウザの中でタブに関係なく共有されるので、タブごとに名前を変える。
 */

/** タブの識別子のヘッダー。画面が、タブごとのランダムな識別子を付ける。秘密ではない（資格は Cookie の値）。 */
internal const val TAB_HEADER = "X-Tab-Id"

/** 識別子の形。Cookie の名前に使うので、英数字だけに絞る（ヘッダー注入と、Cookie の名前の乱用を防ぐ）。 */
private val TAB_ID_PATTERN = Regex("[A-Za-z0-9]{16,64}")

/** 有効なタブの識別子。ヘッダーが無い・形が不正なときは null（従来の Cookie の名前を使う）。 */
internal fun ApplicationCall.tabId(): String? = request.headers[TAB_HEADER]?.takeIf { TAB_ID_PATTERN.matches(it) }

/** 資格の Cookie の名前。タブの識別子があれば `<基本の名前>_<識別子>`、なければ基本の名前。 */
internal fun ApplicationCall.cookieName(base: String): String = tabId()?.let { "${base}_$it" } ?: base

/**
 * 資格の Cookie を読む。タブの名前の Cookie を優先し、無ければ従来の名前の Cookie を使う（タブの識別子を付ける前に発行した資格、
 * 識別子を付けない呼び出し元が発行した資格の移行）。タブ自身は従来の名前を発行しないので、タブ間の分離は保たれる。
 */
internal fun ApplicationCall.cookieValue(base: String): String? =
    request.cookies[cookieName(base)] ?: request.cookies[base]

internal fun ApplicationCall.credential(): String? = cookieValue(COOKIE_NAME)

/** 復帰の経路だけが読む、復帰資格の Cookie。 */
internal fun ApplicationCall.recoveryCredential(): String? = cookieValue(RECOVERY_COOKIE_NAME)
