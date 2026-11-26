package bgs.adapter.persistence

import bgs.application.Tx
import cats.effect.IO
import cats.syntax.all.*
import doobie.*
import doobie.implicits.*

/** トランザクションの実行。**トランザクションの入口を書いてよいのは、このファイルだけ**（静的解析で守る）。 公開する書き込みの実行は [[Tx.run]] だけで、`Transactor`
  * は渡さない。
  */
object Transactions:

  /** 書き込みの実行。`Left` なら ROLLBACK してから終える（doobie は `Left` でも COMMIT するため。K5）。 */
  def writeTx(xa: Transactor[IO]): Tx = new Tx:
    def run[E, A](program: ConnectionIO[Either[E, A]]): IO[Either[E, A]] =
      program
        .flatMap {
          case failure @ Left(_) => FC.rollback.as(failure)
          case success           => success.pure[ConnectionIO]
        }
        .transact(xa)
