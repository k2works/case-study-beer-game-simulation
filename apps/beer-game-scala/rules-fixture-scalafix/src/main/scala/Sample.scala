// Scalafix（DisableSyntax.regex）の規則の確認用。違反するコードを意図的に置いている。ルートの集約に含めない。
// 期待: println（1 件）、clock（2 件: currentTimeMillis・nanoTime）、threadSleep（1 件）、unsafeRun（1 件）の計 5 件。
// ok は報告されない（scripts/check-rules.sh で件数を確かめる）。
object Fake:
  def unsafeRunSync(): Int = 1

// IO.println は正しい書き方なので報告してはならない（ガイドのパターン \bprintln\( は誤検出する）。
object FakeIO:
  def println(text: String): Unit = ()

object Sample:
  def sayOk(): Unit = FakeIO.println("x")
  def say(): Unit = println("x")
  def now(): Long = System.currentTimeMillis()
  def tick(): Long = System.nanoTime()
  def nap(): Unit = Thread.sleep(1)
  def run(): Int = Fake.unsafeRunSync()
  def ok(): Int = 1
