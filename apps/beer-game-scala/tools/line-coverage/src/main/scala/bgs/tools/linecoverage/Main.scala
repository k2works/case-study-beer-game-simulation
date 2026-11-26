package bgs.tools.linecoverage

import cats.effect.{ExitCode, IO, IOApp}
import cats.syntax.all.*

import scala.xml.XML

/** 使い方: `coverageTool/run <scoverage.xml> <しきい値（%）> [<プロジェクト>=<しきい値（%）>…]`。どれかのしきい値を割ると終了コード 1。 */
object Main extends IOApp:

  private val usage: IO[ExitCode] =
    IO
      .println(
        "usage: coverageTool/run <scoverage.xml> <threshold-percent> [<project>=<percent>...]"
      )
      .as(ExitCode.Error)

  private def projectThreshold(arg: String): Option[(String, Int)] =
    arg.split("=", 2) match
      case Array(name, percent) if name.nonEmpty => percent.toIntOption.map(name -> _)
      case _                                     => None

  def run(args: List[String]): IO[ExitCode] =
    args match
      case path :: threshold :: rest =>
        val perProject = rest.map(projectThreshold)
        (threshold.toIntOption, perProject.forall(_.isDefined)) match
          case (Some(percent), true) =>
            IO.blocking(XML.loadFile(path)).flatMap { xml =>
              val checks: List[(String, scala.xml.Elem => LineCoverage.Result, Int)] =
                ("all", LineCoverage.fromXml(_, None), percent) ::
                  perProject.flatten
                    .map((name, limit) => (name, LineCoverage.fromXml(_, Some(name)), limit))
              checks
                .traverse { (name, count, limit) =>
                  val result = count(xml)
                  IO.println(s"line coverage [$name]: ${result.display} (threshold $limit%)")
                    .as(result.meets(limit))
                }
                .map(oks => if oks.forall(identity) then ExitCode.Success else ExitCode.Error)
            }
          case _ => usage
      case _ => usage
