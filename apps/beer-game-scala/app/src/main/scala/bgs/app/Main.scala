package bgs.app

import bgs.adapter.http.Routes
import cats.effect.{IO, IOApp}
import com.comcast.ip4s.{Host, Port, host, port}
import org.http4s.ember.server.EmberServerBuilder

/** サーバーの入口（IO を実行する唯一の場所）。環境変数 `PORT`（既定 8080）で待ち受ける。 B1 は、ローカル開発・受け入れ用の H2（メモリ）だけ。本番の PostgreSQL
  * への接続は、AWS の適用と同じ別ゲート（範囲外）。
  */
object Main extends IOApp.Simple:

  private val defaultPort: Port = port"8080"

  def run: IO[Unit] =
    for
      listen <- IO.delay(sys.env.get("PORT").flatMap(Port.fromString).getOrElse(defaultPort))
      env <- Wiring.inMemoryH2
      _ <- IO.println(s"beer-game-scala: ローカル用 H2（メモリ）で、ポート ${listen.value} を待ち受けます")
      _ <- EmberServerBuilder
        .default[IO]
        .withHost(Host.fromString("0.0.0.0").getOrElse(host"0.0.0.0"))
        .withPort(listen)
        .withHttpApp(Routes.httpApp(env))
        .build
        .useForever
    yield ()
