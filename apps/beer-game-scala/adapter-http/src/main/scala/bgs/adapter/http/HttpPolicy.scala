package bgs.adapter.http

/** HTTP の入口の方針。環境（本番相当かどうか）と設定で決まる。
  *
  * @param allowedOrigins
  *   変更系で許す Origin（`ALLOWED_ORIGINS`）。`Host` と同一の Origin は常に許す
  * @param secureCookies
  *   Cookie に `Secure` を付ける（本番相当）
  * @param maxBodyBytes
  *   本文の上限（NF-P12。64 KB）
  */
final case class HttpPolicy(allowedOrigins: Set[String], secureCookies: Boolean, maxBodyBytes: Long)

object HttpPolicy:
  val MaxBody: Long = 65536L

  /** ローカル・テスト用。許可リストなし（Host と同一の Origin だけ）・Secure なし。 */
  val local: HttpPolicy = HttpPolicy(Set.empty, secureCookies = false, MaxBody)
