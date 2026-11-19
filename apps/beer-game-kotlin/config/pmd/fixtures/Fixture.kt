package sample

class Counter {
    var count = 0                       // NoVarProperty
    val ok = 1
}

fun sum(numbers: List<Int>): Int {
    var total = 0                       // ローカルな var は許す
    for (n in numbers) total += n
    return total
}

fun first(list: List<String>?): String = list!![0]   // NoNotNullAssertion

fun notNull(b: Boolean): Boolean = !b                // 前置の ! は対象外

fun fail(): Nothing = throw IllegalStateException("boom")   // NoThrow

fun add(items: MutableList<String>): MutableList<String> = items   // NoMutableCollectionInSignature（引数と戻り値で 2 件）

private fun addPrivate(items: MutableList<String>): Int = items.size   // private は対象外

fun readOnly(items: List<String>): List<String> = items + "x"          // 読み取り専用は対象外

fun now(): Long = System.currentTimeMillis()                  // SideEffectInNonSuspendFunction
fun log(message: String) { println(message) }                 // SideEffectInNonSuspendFunction
suspend fun castTheDie(): Int = Random.nextInt(1, 7)          // suspend 関数の中は対象外
fun pureScore(word: String): Int = word.length                // 純粋関数は対象外
fun blocking(): Int = runBlocking { 1 }                       // NoRunBlocking
data class Counter2(var x: Int)                                // NoVarClassParameter
fun words(): List<String> { val l = mutableListOf("a"); return l }   // NoMutableCollectionFactory
fun squares(n: Int): List<Int> = buildList { val tmp = mutableListOf(n); addAll(tmp) }   // buildList の中は対象外
fun biggest(n: List<Int>): Int = n.reduce { a, b -> if (a > b) a else b }   // NoReduce
fun safe(): Int = try { 1 } catch (e: Exception) { 0 }          // NoGenericCatch
fun nested(a: List<Int>): List<Int> = a.flatMap { x -> listOf(x).flatMap { y -> listOf(y) } }   // NoNestedFlatMap
fun launchAll() { GlobalScope.launch { } }                     // NoGlobalScope
fun spawn() { thread { } }                                     // NoRawConcurrency
@Synchronized fun sync() {}                                    // NoRawConcurrency
fun nap() { Thread.sleep(10) }                                 // NoThreadSleep
