package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

/** 観察者の事実を採用する関数は、観察者のイベント以外を渡されたら、状態を変えずに返す（全域であること）。 */
class EvolveObserverSpec :
    FunSpec({
        test("Given 観察者のイベントではないイベント When 観察者の事実を採用する Then 状態は変わらない") {
            val state = gameOf(gameCreated(), participantJoined(1))

            state.evolveObserver(gameStarted()) shouldBe state
        }
    })
