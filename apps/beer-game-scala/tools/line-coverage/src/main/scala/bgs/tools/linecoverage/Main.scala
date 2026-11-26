package bgs.tools.linecoverage

import cats.effect.{ExitCode, IO, IOApp}

import scala.xml.XML

/** 使い方: `coverageTool/run <scoverage.xml> <しきい値（%）>`。しきい値を割ると終了コード 1。 */
object Main extends IOApp:

  private val usage: IO[ExitCode] =
    IO.println("usage: coverageTool/run <scoverage.xml> <threshold-percent>").as(ExitCode.Error)

  def run(args: List[String]): IO[ExitCode] =
    args match
      case path :: threshold :: Nil =>
        threshold.toIntOption.fold(usage) { percent =>
          IO.blocking(XML.loadFile(path)).flatMap { xml =>
            val result = LineCoverage.fromXml(xml)
            IO.println(s"line coverage: ${result.display} (threshold $percent%)")
              .as(if result.meets(percent) then ExitCode.Success else ExitCode.Error)
          }
        }
      case _ => usage
