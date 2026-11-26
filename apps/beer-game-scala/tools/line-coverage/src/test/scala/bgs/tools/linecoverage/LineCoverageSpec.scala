package bgs.tools.linecoverage

import munit.FunSuite

import scala.xml.Elem

/** scoverage の XML から行率を算出する（案 C。team の「行 80%」）。既知の値のフィクスチャ XML で確かめる。 */
class LineCoverageSpec extends FunSuite:

  private def statement(source: String, line: Int, count: Int, ignored: Boolean = false): Elem =
    <statement source={source} line={line.toString} invocation-count={count.toString} ignored={
      ignored.toString
    }></statement>

  private def report(statements: Elem*): Elem =
    <statements>{statements}</statements>

  test("[Given 1 行に文が 2 つ（片方だけ実行）, When 行率を算出, Then その行は実行された行に数える]") {
    val xml = report(statement("A.scala", 1, 1), statement("A.scala", 1, 0))
    assertEquals(LineCoverage.fromXml(xml), LineCoverage.Result(coveredLines = 1, totalLines = 1))
  }

  test("[Given 実行されない行と実行される行, When 行率を算出, Then 行ごとに数える]") {
    val xml =
      report(statement("A.scala", 1, 1), statement("A.scala", 2, 0), statement("A.scala", 3, 4))
    assertEquals(LineCoverage.fromXml(xml), LineCoverage.Result(coveredLines = 2, totalLines = 3))
  }

  test("[Given 同じ行番号でもファイルが違う, When 行率を算出, Then 別の行として数える]") {
    val xml = report(statement("A.scala", 1, 1), statement("B.scala", 1, 0))
    assertEquals(LineCoverage.fromXml(xml), LineCoverage.Result(coveredLines = 1, totalLines = 2))
  }

  test("[Given ignored の文, When 行率を算出, Then 数えない]") {
    val xml = report(statement("A.scala", 1, 1), statement("A.scala", 2, 0, ignored = true))
    assertEquals(LineCoverage.fromXml(xml), LineCoverage.Result(coveredLines = 1, totalLines = 1))
  }

  test("[Given sbt-scoverage 2.4.4 が出した実物の形式の XML, When 行率を算出, Then 属性から行を数える]") {
    // 実物の scoverage.xml（2026-11-26、Scala 3.7.4、sbt-scoverage 2.4.4）から、属性をそのまま写した断片
    val xml =
      <scoverage statement-count="2" statements-invoked="1">
        <packages><package name="p"><classes><class name="p.A" filename="p/A.scala"><methods><method name="m">
          <statements>
            <statement package="p" class="A" class-type="Object" full-class-name="p.A" source="/x/p/A.scala" method="m" start="1177" end="1191" line="29" branch="false" invocation-count="1" ignored="false"></statement>
            <statement package="p" class="A" class-type="Object" full-class-name="p.A" source="/x/p/A.scala" method="m" start="1043" end="1111" line="28" branch="false" invocation-count="0" ignored="false"></statement>
          </statements>
        </method></methods></class></classes></package></packages>
      </scoverage>
    assertEquals(LineCoverage.fromXml(xml), LineCoverage.Result(coveredLines = 1, totalLines = 2))
  }

  test("[Given 文が無い, When 行率を算出, Then 0 行 0 行で、しきい値を満たすとみなす（コードが無い）]") {
    val result = LineCoverage.fromXml(report())
    assertEquals(result, LineCoverage.Result(0, 0))
    assert(result.meets(80))
  }

  test("[Given 5 行中 4 行, When しきい値 80, Then ちょうど 80% は満たす（境界）]") {
    assert(LineCoverage.Result(4, 5).meets(80))
  }

  test("[Given 100 行中 79 行, When しきい値 80, Then 満たさない（丸めで通さない）]") {
    assert(!LineCoverage.Result(79, 100).meets(80))
  }

  test("[Given 1000 行中 799 行, When しきい値 80, Then 79.9% は満たさない（小数の丸めで通さない）]") {
    assert(!LineCoverage.Result(799, 1000).meets(80))
  }

  test("[Given 結果, When 表示, Then 小数 1 桁の切り捨てで表示する]") {
    assertEquals(LineCoverage.Result(799, 1000).display, "79.9% (799/1000)")
    assertEquals(LineCoverage.Result(2, 3).display, "66.6% (2/3)")
    assertEquals(LineCoverage.Result(0, 0).display, "n/a (0/0)")
  }

  test("[Given 2 つのプロジェクトのソース, When プロジェクトを指定, Then そのプロジェクトの行だけを数える]") {
    val xml = report(
      statement("/w/domain/src/main/scala/A.scala", 1, 1),
      statement("/w/domain/src/main/scala/A.scala", 2, 1),
      statement("/w/app/src/main/scala/B.scala", 1, 0)
    )
    assertEquals(
      LineCoverage.fromXml(xml, Some("domain")),
      LineCoverage.Result(coveredLines = 2, totalLines = 2)
    )
    assertEquals(
      LineCoverage.fromXml(xml, Some("app")),
      LineCoverage.Result(coveredLines = 0, totalLines = 1)
    )
    assertEquals(LineCoverage.fromXml(xml), LineCoverage.Result(coveredLines = 2, totalLines = 3))
  }
