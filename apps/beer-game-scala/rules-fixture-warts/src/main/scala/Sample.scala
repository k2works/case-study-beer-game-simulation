// 静的解析の規則の確認用。違反するコードを意図的に置いている。ルートの集約に含めない。
// 期待: WartRemover と scalac のオプションが 14 件を報告し、pureOk・sumOk は報告されない
// （関数型プログラミングガイド_Scala編 §9.4 の確認用コード。scripts/check-rules.sh で件数を確かめる）。
final case class Counter(var x: Int)

object Sample:
  var counter = 0

  def nul: String | Null = null

  def boom(): Nothing = throw new IllegalStateException("boom")

  def first(o: Option[Int]): Int = o.get

  def head(xs: List[Int]): Int = xs.head

  def reduced(xs: List[Int]): Int = xs.reduce(_ + _)

  def cast(a: Any): String = a.asInstanceOf[String]

  def isText(a: Any): Boolean = a.isInstanceOf[String]

  def early(xs: List[Int]): Int =
    for x <- xs do if x > 1 then return x
    0

  def mutable(): Int =
    val b = scala.collection.mutable.ListBuffer(1)
    b.size

  def discarded(): Unit =
    List(1, 2).map(_ + 1)

  def todo: Int = ???

  def withDefault(x: Int = 1): Int = x

  def pureOk(xs: List[Int]): Option[Int] = xs.headOption

  def sumOk(xs: List[Int]): Int = xs.foldLeft(0)(_ + _)
