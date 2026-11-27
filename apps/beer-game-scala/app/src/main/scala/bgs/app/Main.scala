package bgs.app

import bgs.adapter.http.{Emf, Routes}
import bgs.application.{Env, RetentionJob, StreamVerifier}
import bgs.adapter.persistence.Migrations
import cats.effect.std.Console
import cats.effect.{ExitCode, IO, IOApp, Resource}
import cats.syntax.all.*
import com.comcast.ip4s.{Host, Port, host}
import org.http4s.ember.server.EmberServerBuilder

/** プロセスの入口（IO を実行する唯一の場所）。起動モードは第 1 引数（既定 `api`）:
  *   - `api`: サーバー（環境変数 `PORT`、既定 8080）。ローカルは H2（メモリ）、本番相当は PostgreSQL（`AppConfig`）
  *   - `migrate`: PostgreSQL にマイグレーションを適用して終了
  *   - `retention`: 保持期限後の削除の掃引を 1 回行って終了（再試行をやめたゲームがあれば 1）
  *   - `verify`: ストリームの整合を検査して終了（不一致があれば 1）
  * 設定の誤りは、項目名だけを示して終了コード 78（EX_CONFIG）。不明なモードは 64（EX_USAGE）。
  */
object Main extends IOApp:

  /** 保持期限後の削除の定期のタスク。間隔（分）は `BGS_RETENTION_INTERVAL_MINUTES`（既定 10。0 なら動かさない）。 */
  private def retentionLoop(env: Env): IO[Unit] =
    IO.delay(sys.env.get("BGS_RETENTION_INTERVAL_MINUTES").flatMap(_.toLongOption).getOrElse(10L))
      .flatMap { minutes =>
        if minutes <= 0L then IO.unit
        else
          val once = RetentionJob
            .runOnce(env)(id =>
              IO.println(s"""{"event":"retention.abandoned","gameId":"${id.value}"}""")
            )
            .void
            .handleErrorWith(e =>
              IO.println(s"""{"event":"retention.error","message":"${e.getClass.getSimpleName}"}""")
            )
          (once *> IO.sleep(
            scala.concurrent.duration.FiniteDuration(minutes, scala.concurrent.duration.MINUTES)
          )).foreverM.void
      }

  /** ストリームの整合の日次検査。間隔（時間）は `BGS_VERIFY_INTERVAL_HOURS`（既定 24。0 なら動かさない）。不一致は構造化ログに出す。 */
  private def verifyLoop(env: Env): IO[Unit] =
    IO.delay(sys.env.get("BGS_VERIFY_INTERVAL_HOURS").flatMap(_.toLongOption).getOrElse(24L))
      .flatMap { hours =>
        if hours <= 0L then IO.unit
        else
          val once = StreamVerifier
            .verify(env)
            .flatMap(found =>
              found.traverse_(m =>
                IO.println(
                  s"""{"event":"verify.mismatch","gameId":"${m.gameId.value}","stream":"${m.stream}","detail":"${m.detail}"}"""
                )
              )
            )
            .handleErrorWith(e =>
              IO.println(s"""{"event":"verify.error","message":"${e.getClass.getSimpleName}"}""")
            )
          (once *> IO.sleep(
            scala.concurrent.duration.FiniteDuration(hours, scala.concurrent.duration.HOURS)
          )).foreverM.void
      }

  private def environment(config: AppConfig): Resource[IO, Env] =
    val secret = config.credentialKey.getOrElse(java.util.UUID.randomUUID.toString * 2)
    config.database match
      case DatabaseConfig.H2Memory     => Resource.eval(Wiring.inMemoryH2)
      case pg: DatabaseConfig.Postgres => Wiring.postgres(pg, secret)

  private def serve(config: AppConfig): IO[ExitCode] =
    environment(config).use { env =>
      for
        _ <- IO.println(s"""{"event":"start","mode":"api","port":${config.port}}""")
        port <- IO.fromOption(Port.fromInt(config.port))(new IllegalStateException("ポート"))
        _ <- (retentionLoop(env).background, verifyLoop(env).background).tupled.use { _ =>
          EmberServerBuilder
            .default[IO]
            .withHost(Host.fromString("0.0.0.0").getOrElse(host"0.0.0.0"))
            .withPort(port)
            .withHttpApp(Routes.httpApp(env))
            .build
            .useForever
        }
      yield ExitCode.Success
    }

  private def migrate(config: AppConfig): IO[ExitCode] =
    config.database match
      case DatabaseConfig.H2Memory =>
        IO.println("""{"event":"migrate","detail":"H2（メモリ）は起動時に適用するので、何もしない"}""")
          .as(ExitCode.Success)
      case DatabaseConfig.Postgres(url, user, password) =>
        Migrations.migratePostgres(url, user, password) *>
          IO.println("""{"event":"migrate","detail":"done"}""").as(ExitCode.Success)

  private def sweep(config: AppConfig): IO[ExitCode] =
    environment(config).use { env =>
      for
        notified <- cats.effect.Ref.of[IO, Int](0)
        deleted <- RetentionJob.runOnce(env)(id =>
          notified.update(_ + 1) *>
            IO.println(s"""{"event":"retention.abandoned","gameId":"${id.value}"}""")
        )
        abandoned <- notified.get
        _ <- IO.println(s"""{"event":"retention.done","deleted":$deleted,"abandoned":$abandoned}""")
        at <- IO.realTimeInstant
        _ <- IO.println(
          Emf
            .gauge(
              "RetentionAbandonedGames",
              abandoned.toLong,
              at,
              config.appEnv.toString.toLowerCase
            )
            .noSpaces
        )
      yield if abandoned > 0 then ExitCode.Error else ExitCode.Success
    }

  private def verify(config: AppConfig): IO[ExitCode] =
    environment(config).use { env =>
      StreamVerifier.verify(env).flatMap { found =>
        found.traverse_(m =>
          IO.println(
            s"""{"event":"verify.mismatch","gameId":"${m.gameId.value}","stream":"${m.stream}","detail":"${m.detail}"}"""
          )
        ) *> IO
          .println(s"""{"event":"verify.done","mismatches":${found.size}}""")
          .as(
            if found.isEmpty then ExitCode.Success else ExitCode.Error
          )
      }
    }

  def run(args: List[String]): IO[ExitCode] =
    val mode = args.headOption.getOrElse("api")
    IO.delay(sys.env).flatMap { env =>
      AppConfig.load(env) match
        case Left(errors) =>
          errors.traverse_(e => Console[IO].errorln(s"設定の誤り: $e")).as(ExitCode(78))
        case Right(config) =>
          mode match
            case "api"       => serve(config)
            case "migrate"   => migrate(config)
            case "retention" => sweep(config)
            case "verify"    => verify(config)
            case other       =>
              Console[IO]
                .errorln(s"不明なモード: $other（api・migrate・retention・verify）")
                .as(ExitCode(64))
    }
