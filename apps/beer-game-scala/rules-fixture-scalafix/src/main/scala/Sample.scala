// Scalafix（DisableSyntax.regex）の規則の確認用。違反するコードを意図的に置いている。ルートの集約に含めない。
// 期待: println（1 件）、clock（2 件: currentTimeMillis・nanoTime）、threadSleep（1 件）、unsafeRun（1 件）の計 5 件。
// ok は報告されない（scripts/check-rules.sh で件数を確かめる）。
object FakeRun:
  def unsafeRunSync(): Int = 1

// IO.println は正しい書き方なので報告してはならない（ガイドのパターン \bprintln\( は誤検出する）。
object FakeIO:
  def println(text: String): Unit = ()

// トランザクションの入口は Transactions だけ。transact の呼び出しと、COMMIT・ROLLBACK の制御は報告し、
// Transactions の writeTx のような名前は報告してはならない（落ちてはならない方向）。
object Fake:
  def transact(n: Int): Int = n

object FC:
  def rollback: Int = 0

object Transactions:
  def writeTx(n: Int): Int = n

object Sample:
  def txViolation(): Int = Fake.transact(1)
  def rollbackViolation(): Int = FC.rollback
  def txOk(): Int = Transactions.writeTx(1)
  def sayOk(): Unit = FakeIO.println("x")
  def say(): Unit = println("x")
  def now(): Long = System.currentTimeMillis()
  def tick(): Long = System.nanoTime()
  def nap(): Unit = Thread.sleep(1)
  def run(): Int = FakeRun.unsafeRunSync()
  def ok(): Int = 1
