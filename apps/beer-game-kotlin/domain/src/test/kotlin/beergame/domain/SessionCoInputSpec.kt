package beergame.domain

import arrow.core.left
import arrow.core.right
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe
import java.lang.reflect.Field
import java.lang.reflect.Modifier
import java.lang.reflect.ParameterizedType
import java.lang.reflect.Type

/*
 * 共同入力（B6 Step 2。AC1.2.4・AC2.2.3・AC2.1.4）。同じ役割に 2 人の参加者（共同担当）がいる Session で、
 * 保存の競合・版・保存回数の上限・確定の判定を固定する。版の意味は B5 から変えない（判断項目 5）。
 * 小売店の担当者は、参加者 4（担当者 A）と、参加者 14（共同担当 B）。ほかの役割も同じ形で、2 人ずつ。
 */

private val settings = gameSettings(listOf(4, 8, 4))
private val coFresh: SessionState = coStateOf()
private val retailer = Role.RETAILER
private val holderA: Actor = participantActor(retailer.ordinal + 1)
private val holderB: Actor = coHolderActor(retailer)
private val editorA: Editor = Editor.ByParticipant(pid(retailer.ordinal + 1))
private val editorB: Editor = coHolderEditor(retailer)

private fun coStateOf(vararg events: SessionEvent): SessionState =
    sessionOf(sessionStarted(settings, coAssignedParticipants), *events)

private fun entryOf(
    quantity: Int,
    version: Long,
    editor: Editor,
): DecisionEntry = DecisionEntry(q(quantity), dv(version), editor)

/** 小売店が [times] 回保存した事実。奇数回目は担当者 A、偶数回目は共同担当 B が保存する（版は 1 から [times]）。 */
private fun alternatingSaves(times: Int): List<SessionEvent> =
    (1..times).map {
        decisionSavedBy(if (it % 2 == 1) editorA else editorB, retailer, it, it.toLong())
    }

/** 小売店の保存の事実。入力者は、担当者 A（[savedByA]）か、共同担当 B（[savedByB]）。 */
private fun savedByA(
    quantity: Int,
    version: Long = 1,
): SessionEvent = decisionSavedBy(editorA, retailer, quantity, version)

private fun savedByB(
    quantity: Int,
    version: Long = 1,
): SessionEvent = decisionSavedBy(editorB, retailer, quantity, version)

private val SESSION_EVENT_TYPES: List<Class<*>> =
    SessionEvent::class.java.permittedSubclasses.toList() + Editor::class.java.permittedSubclasses.toList()

/** 表示名・資格を持つ項目の名前（イベントのペイロードに含めない。ADR-002）。 */
private val FORBIDDEN_FIELD = Regex("display|name|token|credential|secret|password", RegexOption.IGNORE_CASE)

private fun payloadFields(
    type: Type,
    seen: MutableSet<Class<*>> = mutableSetOf(),
): List<Field> {
    val raw: Class<*> =
        when (type) {
            is Class<*> -> type
            is ParameterizedType -> type.rawType as Class<*>
            else -> return emptyList()
        }
    val arguments = (type as? ParameterizedType)?.actualTypeArguments.orEmpty().flatMap { payloadFields(it, seen) }
    val own =
        if (raw.name.startsWith("beergame.domain") && seen.add(raw)) {
            raw.declaredFields.filterNot { Modifier.isStatic(it.modifiers) }
        } else {
            emptyList()
        }
    return own + arguments + own.flatMap { payloadFields(it.genericType, seen) }
}

class SessionCoInputSpec :
    FunSpec({
        context("[US1.2/AC1.2.4] 共同担当（同じ役割に 2 人）は、どちらも、その役割の入力を保存できる") {
            test("When 担当者 A が保存 Then DecisionSaved（入力者は A）") {
                decideSession(coFresh, saveDecision(retailer, 5, actor = holderA)) shouldBe
                    listOf(savedByA(5)).right()
            }
            test("When 共同担当 B が保存 Then DecisionSaved（入力者は B。Forbidden にならない）") {
                decideSession(coFresh, saveDecision(retailer, 7, actor = holderB)) shouldBe
                    listOf(savedByB(7)).right()
            }
            test("When 別の役割の担当者（共同担当を含む）が小売店へ保存 Then Forbidden（共同担当は役割の内側だけ）") {
                val others = listOf(participantActor(3), coHolderActor(Role.WHOLESALER), coHolderActor(Role.FACTORY))
                others.forEach { actor ->
                    decideSession(coFresh, saveDecision(retailer, 7, actor = actor)) shouldBe
                        SessionError.Forbidden("その役割の参加者だけが入力できる").left()
                }
            }
        }

        context("[US2.2/AC2.2.3] 同じ版から 2 人が保存すると、2 人目は競合し、最新値と保存者を返す（変更を黙って失わない）") {
            val afterA = coStateOf(savedByA(5))
            val staleByB = saveDecision(retailer, 7, actor = holderB, expectedVersion = 0)

            test("Given A が保存済み（5・版 1） When B が古い版 0 を期待して保存 Then DecisionConflict（最新値 5・版 1・保存者 A）") {
                decideSession(afterA, staleByB) shouldBe
                    SessionError.DecisionConflict(retailer, entryOf(5, 1, editorA)).left()
            }
            test("拒否された B の値は状態に入らない（最新の値は A のまま、版も増えない）") {
                decideSession(afterA, staleByB).isLeft() shouldBe true
                val data = sessionDataOf(afterA)
                data.decisions[retailer] shouldBe entryOf(5, 1, editorA)
                data.decisionVersions[retailer] shouldBe dv(1)
            }
            test("When B が最新の版 1 を指定して保存し直す Then 版 2 で受理（入力者は B）し、状態の最新値は B の値になる") {
                val events = decideSession(afterA, saveDecision(retailer, 7, actor = holderB, expectedVersion = 1))
                events shouldBe listOf(savedByB(7, version = 2)).right()
                val next = events.valid("保存").fold(afterA, ::evolveSession)
                sessionDataOf(next).decisions[retailer] shouldBe entryOf(7, 2, editorB)
                sessionDataOf(next).decisionVersions[retailer] shouldBe dv(2)
            }
            test("同じ版から 2 人が続けて保存すると、受理されるのは 1 人目だけ（2 人目の競合は、最新値として 1 人目の入力を返す）") {
                val first = decideSession(coFresh, saveDecision(retailer, 5, actor = holderA, expectedVersion = 0))
                val next = first.valid("1 人目").fold(coFresh, ::evolveSession)
                decideSession(next, saveDecision(retailer, 7, actor = holderB, expectedVersion = 0)) shouldBe
                    SessionError.DecisionConflict(retailer, entryOf(5, 1, editorA)).left()
            }
            test("Given 進行役の代理入力（版 2）の後 When A が古い版 1 で保存 Then DecisionConflict（保存者は進行役の代理入力）") {
                val afterProxy =
                    coStateOf(savedByA(5), proxyDecisionSubmitted(retailer, 9, version = 2))
                decideSession(afterProxy, saveDecision(retailer, 6, actor = holderA, expectedVersion = 1)) shouldBe
                    SessionError.DecisionConflict(retailer, entryOf(9, 2, facilitatorEditor)).left()
            }
            test("週が古い保存は、版も古くても WeekAdvanced（共同入力の競合でなく、週の経過を先に返す）") {
                val saved = coStateOf(*allSavedEvents(same(4)).toTypedArray())
                val afterWeek1 = committedWeekEvents(saved, same(4)).fold(saved, ::evolveSession)
                val stale = saveDecision(retailer, 6, actor = holderB, week = 1, expectedVersion = 0)
                decideSession(afterWeek1, stale) shouldBe SessionError.WeekAdvanced(w(1), w(2)).left()
            }
        }

        context("[NF-C8] 保存回数の上限（9 回）は、役割ごとに共同担当で共有され、拒否された保存は数えない（判断項目 5）") {
            test("Given A と B が交互に 8 回保存済み When 9 回目を A が保存 Then 受理（版 9）。その後は A も B も SaveLimitReached") {
                val state = coStateOf(*alternatingSaves(8).toTypedArray())
                val ninth = decideSession(state, saveDecision(retailer, 99, actor = holderA, expectedVersion = 8))
                ninth shouldBe listOf(savedByA(99, version = 9)).right()
                val full = coStateOf(*alternatingSaves(9).toTypedArray())
                listOf(holderA, holderB).forEach { actor ->
                    decideSession(full, saveDecision(retailer, 5, actor = actor, expectedVersion = 9)) shouldBe
                        SessionError.SaveLimitReached.left()
                }
            }
            test("共同担当の人数では上限が増えない: A だけで 9 回保存した後は、B（共同担当）も SaveLimitReached") {
                val full = coStateOf(*savedTimes(retailer, 9).toTypedArray())
                decideSession(full, saveDecision(retailer, 5, actor = holderB, expectedVersion = 9)) shouldBe
                    SessionError.SaveLimitReached.left()
            }
            test("上限は役割ごと: 小売店が 9 回でも、工場の共同担当は保存できる") {
                val full = coStateOf(*alternatingSaves(9).toTypedArray())
                decideSession(full, saveDecision(Role.FACTORY, 5, actor = coHolderActor(Role.FACTORY))) shouldBe
                    listOf(
                        decisionSavedBy(coHolderEditor(Role.FACTORY), Role.FACTORY, 5, submittedRoleCount = 2),
                    ).right()
            }
            test("拒否された保存（競合）は、版も保存回数も進めない: 古い版の保存を 20 回拒否された後も、9 回目まで受理される") {
                val state = coStateOf(*alternatingSaves(8).toTypedArray())
                (1..20).forEach { n ->
                    val stale = saveDecision(retailer, n, actor = holderB, expectedVersion = 3)
                    decideSession(state, stale).leftOrNull() shouldBe
                        SessionError.DecisionConflict(retailer, entryOf(8, 8, editorB))
                }
                sessionDataOf(state).decisionVersions[retailer] shouldBe dv(8)
                decideSession(state, saveDecision(retailer, 5, actor = holderB, expectedVersion = 8)) shouldBe
                    listOf(savedByB(5, version = 9)).right()
            }
            test("判定順: 上限に達した後でも、共同担当が古い版で保存すれば、SaveLimitReached でなく DecisionConflict（最新値を返す）") {
                val full = coStateOf(*alternatingSaves(9).toTypedArray())
                decideSession(full, saveDecision(retailer, 5, actor = holderB, expectedVersion = 3)) shouldBe
                    SessionError.DecisionConflict(retailer, entryOf(9, 9, editorA)).left()
            }
            test("上限の拒否も状態を変えない: 9 回保存済みの後の拒否で、最新値・版は 9 回目のまま") {
                val full = coStateOf(*alternatingSaves(9).toTypedArray())
                val overLimit = saveDecision(retailer, 5, actor = holderB, expectedVersion = 9)
                decideSession(full, overLimit) shouldBe SessionError.SaveLimitReached.left()
                sessionDataOf(full).decisions[retailer] shouldBe entryOf(9, 9, editorA)
                sessionDataOf(full).decisionVersions[retailer] shouldBe dv(9)
            }
        }

        context("[US2.3] 共同入力と確定（設計判断 D10: 確定の根拠は、ストリームの版でなく、週と意思決定の版）") {
            val allSaved = coStateOf(*allSavedEvents(same(4)).toTypedArray())
            val retailerResaved =
                coStateOf(
                    *allSavedEvents(same(4)).toTypedArray(),
                    decisionSavedBy(editorB, retailer, 4, version = 2, submittedRoleCount = 4),
                )
            val basisAfterResave = RoleMap(dv(1), dv(1), dv(1), dv(2))

            test("確定の根拠にした入力が、共同担当の保存で変わった後の確定は DecisionsChanged（現在の値と保存者を返す）") {
                val current = Role.entries.associateWith { entryOf(4, 1, Editor.ByParticipant(pid(it.ordinal + 1))) }
                decideSession(retailerResaved, commitWeek(basis = RoleMap.all(dv(1)))) shouldBe
                    SessionError.DecisionsChanged(w(1), current + (retailer to entryOf(4, 2, editorB))).left()
            }
            test("同じ値（4）の保存し直しでも、版が進むので DecisionsChanged になる（事実: 版は値の変化でなく保存で数える）") {
                sessionDataOf(retailerResaved).decisions[retailer]?.quantity shouldBe q(4)
                decideSession(retailerResaved, commitWeek(basis = RoleMap.all(dv(1)))).leftOrNull() shouldBe
                    SessionError.DecisionsChanged(w(1), sessionDataOf(retailerResaved).decisions)
            }
            test("開き直して、最新の版を根拠にすれば、共同担当が保存し直した後でも確定できる") {
                val result = decideSession(retailerResaved, commitWeek(basis = basisAfterResave)).valid("確定")
                committedOf(result).week shouldBe w(1)
            }
            test("入力が変わらなければ、ストリームの版が進んでも（停止・再開）確定できる") {
                val pausedAndResumed =
                    evolveSession(evolveSession(allSaved, SessionEvent.SessionPaused), SessionEvent.SessionResumed)
                (pausedAndResumed.version.value > allSaved.version.value) shouldBe true
                committedOf(decideSession(pausedAndResumed, commitWeek()).valid("確定")).week shouldBe w(1)
            }
            test("週が違えば、根拠も違っても WeekAdvanced（週が先。DecisionsChanged ではない）") {
                decideSession(retailerResaved, commitWeek(week = 2, basis = RoleMap.all(dv(1)))) shouldBe
                    SessionError.WeekAdvanced(w(2), w(1)).left()
            }
            test("共同担当の保存で 4 役割がそろっても、週は確定しない（保存の事実 1 件だけ。自動確定は B8）") {
                val threeSaved = coStateOf(*allSavedEvents(same(4)).drop(1).toTypedArray())
                val result =
                    decideSession(threeSaved, saveDecision(Role.FACTORY, 4, actor = coHolderActor(Role.FACTORY)))
                result shouldBe
                    listOf(
                        decisionSavedBy(coHolderEditor(Role.FACTORY), Role.FACTORY, 4, submittedRoleCount = 4),
                    ).right()
            }
        }

        context("[ADR-002] session のイベントのペイロード（入力者を含む）に、表示名・資格を含めない") {
            test("イベントと入力者の型を、構成する型まで辿って、表示名・資格・トークンを表す項目が無い") {
                SESSION_EVENT_TYPES.isNotEmpty() shouldBe true
                val offenders =
                    SESSION_EVENT_TYPES
                        .flatMap { payloadFields(it) }
                        .map { it.declaringClass.simpleName + "." + it.name }
                        .filter { FORBIDDEN_FIELD.containsMatchIn(it.substringAfter('.')) }
                offenders.shouldBeEmpty()
            }
            test("検査が働く: 項目を辿れていて（入力者の項目と役割の割り当ての項目を含む）、表示名の項目を持つ型は検出する") {
                val names = SESSION_EVENT_TYPES.flatMap { payloadFields(it) }.map { it.name }
                (listOf("editor", "assignments", "quantity").all { it in names }) shouldBe true
                payloadFields(DisplayNameHolder::class.java).map { it.name } shouldBe listOf("displayName")
                FORBIDDEN_FIELD.containsMatchIn("displayName") shouldBe true
            }
            test("共同担当の入力者は、参加者の識別子だけを持つ（表示名を含まない）") {
                payloadFields(Editor.ByParticipant::class.java).map { it.name } shouldBe listOf("id")
                payloadFields(Editor.ByFacilitator::class.java).map { it.name } shouldBe listOf("gameId")
            }
        }
    })

/** [payloadFields] が表示名の項目を検出できることを確かめるための、ペイロードの悪い例。 */
private class DisplayNameHolder(
    val displayName: String,
)
