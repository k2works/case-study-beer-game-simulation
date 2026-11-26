package bgs.tools.linecoverage

import scala.xml.Elem

/** scoverage の XML から行率を算出する。scoverage 自体は文と分岐の率しか出さない（K16）ので、 文の行番号（`source` と `line`）から行を数える。 */
object LineCoverage:

  /** 1 行に実行された文が 1 つでもあれば、その行は実行された行に数える。 */
  final case class Result(coveredLines: Int, totalLines: Int):

    /** 整数だけで比較し、小数の丸めで通さない。行が 0 件（コードが無い）のときは満たす。 */
    def meets(thresholdPercent: Int): Boolean =
      coveredLines.toLong * 100L >= thresholdPercent.toLong * totalLines.toLong

    /** 小数 1 桁の切り捨てで表示する。 */
    def display: String =
      if totalLines == 0 then s"n/a ($coveredLines/$totalLines)"
      else
        val tenths = coveredLines.toLong * 1000L / totalLines.toLong
        s"${tenths / 10}.${tenths % 10}% ($coveredLines/$totalLines)"

  /** sbt-scoverage 2.4.4 の XML は、`<statement source=… line=… invocation-count=… ignored=…>` と属性で持つ。
    */
  private def attribute(node: scala.xml.Node, name: String): String =
    node.attribute(name).fold("")(_.text.trim)

  /** `project` を指定すると、その sbt プロジェクトのソース（`/<project>/src/`）の行だけを数える。 */
  def fromXml(xml: Elem): Result = fromXml(xml, None)

  def fromXml(xml: Elem, project: Option[String]): Result =
    val lineCovered: Map[(String, Int), Boolean] =
      (xml \\ "statement").toList
        .filter(statement => attribute(statement, "ignored") != "true")
        .filter(statement =>
          project.forall(name => attribute(statement, "source").contains(s"/$name/src/"))
        )
        .flatMap { statement =>
          val source = attribute(statement, "source")
          val invoked = attribute(statement, "invocation-count").toIntOption.exists(_ > 0)
          attribute(statement, "line").toIntOption.map(line => (source, line) -> invoked)
        }
        .groupMapReduce(_._1)(_._2)(_ || _)
    Result(lineCovered.count(_._2), lineCovered.size)
