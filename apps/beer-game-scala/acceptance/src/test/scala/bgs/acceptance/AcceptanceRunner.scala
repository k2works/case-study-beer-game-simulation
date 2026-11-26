package bgs.acceptance

import java.nio.file.{Files, Path, Paths}
import scala.jdk.CollectionConverters.*

/** 共有の features（Kotlin 版・Rust 版と共有。変更しない）のうち、許可リストにあるシナリオだけを、cucumber で実行する。 許可したシナリオに
  * Undefined・Pending があれば失敗（cucumber の既定。終了コード 1）。
  *
  * 使い方: `sbt "acceptance/Test/runMain bgs.acceptance.AcceptanceRunner"`（scripts/acceptance.sh）。
  * 許可リストの形式: `<機能領域>/<ファイル>.feature`（@api の全シナリオ）、または `... :: <シナリオ名>`。
  */
object AcceptanceRunner:

  // sbt のフォークした JVM の作業ディレクトリは、プロジェクトのディレクトリ（apps/beer-game-scala/acceptance）
  private val FeaturesDir: Path = Paths.get("../../beer-game-features")
  private val AllowlistFile: Path = Paths.get("allowlist.txt")

  /** 許可リストの 1 行を、cucumber に渡す位置（ファイル、またはファイル:行）にする。 */
  private def locations(line: String): List[String] =
    line.split("::", 2).toList.map(_.trim) match
      case file :: Nil       => List(FeaturesDir.resolve(file).toString)
      case file :: name :: _ =>
        val path = FeaturesDir.resolve(file)
        val lines = Files.readAllLines(path).asScala.toList
        lines.zipWithIndex
          .collect {
            case (text, index)
                if text.trim.matches(s"^シナリオ(アウトライン)?: ${java.util.regex.Pattern.quote(name)}$$") =>
              s"$path:${index + 1}"
          }
      case _ => Nil

  def main(args: Array[String]): Unit =
    val entries = Files
      .readAllLines(AllowlistFile)
      .asScala
      .toList
      .map(_.trim)
      .filter(l => l.nonEmpty && !l.startsWith("#"))
    val targets = entries.flatMap(locations)
    require(targets.nonEmpty, "許可リストが空")
    val cucumberArgs =
      List(
        "--glue",
        "bgs.acceptance",
        "--tags",
        "@api",
        "--plugin",
        "summary",
        "--plugin",
        "progress"
      ) ++ targets
    val status = io.cucumber.core.cli.Main.run(cucumberArgs*)
    sys.exit(status.toInt)
