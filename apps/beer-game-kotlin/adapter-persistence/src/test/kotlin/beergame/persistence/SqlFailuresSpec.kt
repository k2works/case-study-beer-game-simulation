package beergame.persistence

import beergame.application.AppFailure
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.types.shouldBeInstanceOf
import java.sql.SQLException

/**
 * SQLSTATE と制約名の、失敗への写像（B6 Step 4.1g）。実 DB で 40001・40P01・55P03 を安定して起こすのは難しいので、
 * 写像そのものを単体で確かめる（実 DB で起こした競合は、coInputConcurrencyContract。起こしていない範囲はここだけ）。
 */
class SqlFailuresSpec :
    FunSpec({
        test("[B6/4.1g] 40001（直列化の失敗）と 40P01（デッドロック）は、再試行の対象の競合（ConcurrencyConflict）") {
            SQLException("serialization", "40001").toAppFailure("op") shouldBe AppFailure.ConcurrencyConflict
            SQLException("deadlock", "40P01").toAppFailure("op") shouldBe AppFailure.ConcurrencyConflict
        }

        test("[B6/4.1g] 55P03（ロックの待ちの上限）は、再試行の枯渇（RetryExhausted）で、競合として再試行しない") {
            SQLException("lock timeout", "55P03").toAppFailure("op") shouldBe AppFailure.RetryExhausted
        }

        test("[B6/4.1g] 再試行の対象の一意制約（イベントの版・冪等記録 2 種）の違反は、競合（ConcurrencyConflict）") {
            ConstraintNames.retryable.forEach { constraint ->
                SQLException("duplicate key value violates unique constraint \"$constraint\"", "23505")
                    .toAppFailure("op") shouldBe AppFailure.ConcurrencyConflict
            }
        }

        test("[B6/4.1g] 再試行の対象でない一意制約の違反は、競合にせず Persistence（設計上起きないので 500）で、行の値を載せない") {
            val failure =
                SQLException(
                    "duplicate key value violates unique constraint \"uq_something_else\" VALUES (secret-value)",
                    "23505",
                ).toAppFailure("op")

            failure.shouldBeInstanceOf<AppFailure.Persistence>()
            failure.toString() shouldNotContain "secret-value"
        }

        test("[B6/4.1g] 想定外の SQLSTATE は Persistence（再試行しない）") {
            SQLException("boom", "XX000").toAppFailure("op").shouldBeInstanceOf<AppFailure.Persistence>()
        }
    })
