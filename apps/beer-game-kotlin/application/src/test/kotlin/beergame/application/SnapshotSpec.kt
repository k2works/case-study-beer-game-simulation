package beergame.application

import beergame.domain.CredentialSubject
import beergame.domain.Editor
import beergame.domain.GameId
import beergame.domain.ParticipantId
import beergame.domain.Role
import beergame.domain.StreamVersion
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import java.time.Instant
import java.util.UUID

/** 保存の時刻（投影 `current_decisions.updated_at`）。 */
private val SAVED_AT: Instant = Instant.parse("2026-11-16T10:42:00Z")

/** 役割ごとの値が、他の値と紛れない 4 桁の目印（在庫、受注残、入荷、受注の順）。 */
private val MARKERS: Map<Role, List<Int>> =
    mapOf(
        Role.FACTORY to listOf(1101, 1102, 1103, 1104),
        Role.DISTRIBUTOR to listOf(2201, 2202, 2203, 2204),
        Role.WHOLESALER to listOf(3301, 3302, 3303, 3304),
        Role.RETAILER to listOf(4401, 4402, 4403, 4404),
    )

private fun versions(
    game: Long,
    session: Long?,
) = Versions(StreamVersion.of(game).ok(), session?.let { StreamVersion.of(it).ok() })

private fun projectedOf(
    game: Prepared,
    names: Map<Role, String>,
    session: ProjectedSession? = ProjectedSession(SessionStatus.ACTIVE, 2, 1),
    decisions: Map<Role, ProjectedDecision> =
        mapOf(
            Role.WHOLESALER to
                ProjectedDecision(
                    2,
                    3399,
                    5,
                    Editor.ByParticipant(game.seats[Role.WHOLESALER].participantId),
                    SAVED_AT,
                ),
        ),
): ProjectedGame =
    ProjectedGame(
        gameId = game.gameId,
        status = GameStatus.STARTED,
        finalWeek = 12,
        joinCode = game.created.joinCode,
        participants =
            Role.entries.map { ProjectedParticipant(game.seats[it].participantId, names.getValue(it), it) },
        session = session,
        roleStates =
            MARKERS.mapValues { (_, v) -> ProjectedRoleState(v[0], v[1], v[2], v[3], 9000L + v[0], 2) },
        decisions = decisions,
        results =
            Role.entries.map {
                ProjectedWeekResult(
                    1,
                    it,
                    MARKERS.getValue(it)[3],
                    4,
                    4,
                    MARKERS.getValue(it)[0],
                    0,
                    50,
                    50,
                )
            },
        versions = versions(10, 7),
    )

private val NAMES: Map<Role, String> =
    mapOf(Role.FACTORY to "工場の花子", Role.DISTRIBUTOR to "一次卸の次郎", Role.WHOLESALER to "二次卸の三郎", Role.RETAILER to "小売の四郎")

private fun Snapshot.participantView(): SnapshotView.Participant =
    view as? SnapshotView.Participant ?: error("参加者の投影ではない: $view")

private fun Snapshot.facilitatorView(): SnapshotView.Facilitator =
    view as? SnapshotView.Facilitator ?: error("進行役の投影ではない: $view")

/** 問い合わせ（GET state 相当）。呼び出した人ごとの投影と、開示の規則（AC2.1.x）。 */
class SnapshotSpec :
    FunSpec({
        test("[US2.1/AC2.1.1] Given 二次卸の参加者 When 自分の役割の状況を取得する Then 二次卸の在庫・受注残・入荷・受注が返り、他の役割の値は含まれない") {
            val world = World()
            val game = world.started()
            world.projectedGame = projectedOf(game, NAMES)

            val snapshot = world.ports.snapshot(game.gameId, game.seats[Role.WHOLESALER].credential).ok()

            val status = checkNotNull(snapshot.participantView().status)
            listOf(status.inventory, status.backlog, status.arrivals, status.orders) shouldContainExactly
                MARKERS.getValue(Role.WHOLESALER)
            snapshot.participantView().role shouldBe Role.WHOLESALER
            val text = snapshot.toString()
            listOf(Role.FACTORY, Role.DISTRIBUTOR, Role.RETAILER).forEach { other ->
                MARKERS.getValue(other).forEach { text shouldNotContain it.toString() }
            }
        }

        test("[US2.1/AC2.1.3] Given 二次卸の参加者 When 自分の役割の状況を取得する Then 当週の顧客需要は含まれない（受注は上流への発注であって顧客需要ではない）") {
            val world = World()
            val game = world.started()
            world.projectedGame = projectedOf(game, NAMES)

            val snapshot = world.ports.snapshot(game.gameId, game.seats[Role.WHOLESALER].credential).ok()

            checkNotNull(snapshot.participantView().status).customerDemand shouldBe null
        }

        test("[US2.1/AC2.1.3] Given 小売店の参加者 When 自分の役割の状況を取得する Then 当週の顧客需要が含まれる") {
            val world = World()
            val game = world.started()
            world.projectedGame = projectedOf(game, NAMES)

            val snapshot = world.ports.snapshot(game.gameId, game.seats[Role.RETAILER].credential).ok()

            checkNotNull(snapshot.participantView().status).customerDemand shouldBe MARKERS.getValue(Role.RETAILER)[3]
        }

        test("[US2.1/AC2.1.2] Given 二次卸の参加者 When 小売店の状況を取得しようとする Then 権限エラー（game.forbidden）で、値は返らない") {
            val world = World()
            val game = world.started()
            world.projectedGame = projectedOf(game, NAMES)

            val result =
                world.ports.snapshot(
                    game.gameId,
                    game.seats[Role.WHOLESALER].credential,
                    requestedRole = Role.RETAILER,
                )

            result.domainCode() shouldBe "game.forbidden"
        }

        test("[US2.1/AC2.1.2] Given 二次卸の参加者 When 自分の役割を明示して取得する Then 返る") {
            val world = World()
            val game = world.started()
            world.projectedGame = projectedOf(game, NAMES)

            world.ports
                .snapshot(
                    game.gameId,
                    game.seats[Role.WHOLESALER].credential,
                    requestedRole = Role.WHOLESALER,
                ).ok()
        }

        test("[US2.1] Given 参加者 When 取得する Then 参加コードと他の参加者の表示名と他の役割の入力は含まれない") {
            val world = World()
            val game = world.started()
            world.projectedGame =
                projectedOf(
                    game,
                    NAMES,
                    decisions =
                        mapOf(
                            Role.RETAILER to ProjectedDecision(2, 4488, 1, Editor.ByFacilitator(game.gameId), SAVED_AT),
                        ),
                )

            val snapshot = world.ports.snapshot(game.gameId, game.seats[Role.WHOLESALER].credential).ok()

            val text = snapshot.toString()
            text shouldNotContain game.created.joinCode
            listOf(Role.FACTORY, Role.DISTRIBUTOR, Role.RETAILER).forEach { text shouldNotContain NAMES.getValue(it) }
            text shouldNotContain "4488"
        }

        test("[US2.1] Given 二次卸の参加者の入力がある When 取得する Then 自分の入力（数量と版）は返る") {
            val world = World()
            val game = world.started()
            world.projectedGame = projectedOf(game, NAMES)

            val status =
                checkNotNull(
                    world.ports
                        .snapshot(
                            game.gameId,
                            game.seats[Role.WHOLESALER].credential,
                        ).ok()
                        .participantView()
                        .status,
                )

            status.decision shouldBe 3399
            status.decisionVersion shouldBe 5
        }

        test("[US2.1] Given 進行役 When 取得する Then 全役割の状況・入力・参加コード・ロビー・確定した週の結果が返る") {
            val world = World()
            val game = world.started()
            world.projectedGame = projectedOf(game, NAMES)

            val snapshot = world.ports.snapshot(game.gameId, game.facilitator).ok()

            val view = snapshot.facilitatorView()
            view.joinCode shouldBe game.created.joinCode
            view.roles.keys shouldBe Role.entries.toSet()
            Role.entries.forEach { role -> view.roles.getValue(role).inventory shouldBe MARKERS.getValue(role)[0] }
            view.roles.getValue(Role.WHOLESALER).decision shouldBe 3399
            view.lobby.map { it.displayName } shouldContainExactly Role.entries.map { NAMES.getValue(it) }
            view.results.size shouldBe 4
            view.finalWeek shouldBe 12
        }

        test("[US2.3/AC2.3.5] Given 進行役 When 確定した週の結果を取得する Then 4 役割のそれぞれに、注文・出荷・在庫・受注残・費用が含まれる") {
            val world = World()
            val game = world.started()
            world.projectedGame = projectedOf(game, NAMES)

            val results =
                world.ports
                    .snapshot(game.gameId, game.facilitator)
                    .ok()
                    .facilitatorView()
                    .results

            results.map { it.role } shouldContainExactly Role.entries
            results.forEach { it.week shouldBe 1 }
            results.first { it.role == Role.RETAILER }.let {
                it.orders shouldBe MARKERS.getValue(Role.RETAILER)[3]
                it.endingInventory shouldBe MARKERS.getValue(Role.RETAILER)[0]
                it.weeklyCostMinor shouldBe 50
            }
        }

        test("[US2.3/AC2.3.1] Given 週が進んだ後 When 取得する Then 現在の週・状態・版を、投影のとおり返す") {
            val world = World()
            val game = world.started()
            world.projectedGame = projectedOf(game, NAMES)

            val snapshot = world.ports.snapshot(game.gameId, game.seats[Role.RETAILER].credential).ok()

            snapshot.session shouldBe SessionSummary(SessionStatus.ACTIVE, 2, 1)
            snapshot.versions shouldBe versions(10, 7)
            snapshot.gameId shouldBe game.gameId
        }

        test("[US2.1] Given 準備中のゲーム When 役割のある参加者が取得する Then 状況は無く、役割だけが返る") {
            val world = World()
            val game = world.prepared()
            world.projectedGame =
                projectedOf(game, NAMES, session = null).copy(status = GameStatus.PREPARING, roleStates = emptyMap())

            val snapshot = world.ports.snapshot(game.gameId, game.seats[Role.FACTORY].credential).ok()

            snapshot.participantView().role shouldBe Role.FACTORY
            snapshot.participantView().status shouldBe null
            snapshot.session shouldBe null
        }

        test("[US2.1] Given 資格が無い、無効、失効、別のゲーム、存在しないゲーム When 取得しようとする Then どれも同じ app.unauthorized") {
            val world = World()
            val game = world.started(tag = "a")
            val other = world.started(tag = "b")
            world.projectedGame = projectedOf(game, NAMES)
            world.ports
                .revokeCredential(
                    game.gameId,
                    CredentialSubject.Participant(game.seats[Role.FACTORY].participantId),
                    meta("revoke-factory", game.facilitator),
                ).ok()

            val results =
                listOf(
                    world.ports.snapshot(game.gameId, null),
                    world.ports.snapshot(game.gameId, "not-a-credential"),
                    world.ports.snapshot(game.gameId, game.seats[Role.FACTORY].credential),
                    world.ports.snapshot(game.gameId, other.seats[Role.FACTORY].credential),
                    world.ports.snapshot(game.gameId, other.facilitator),
                    world.ports.snapshot(GameId(java.util.UUID(5L, 5L)), game.facilitator),
                )

            results.forEach { it.err() shouldBe AppFailure.Unauthorized }
        }

        test("[US2.1] Given 資格は有効だが投影が無い When 取得する Then 存在を明かさず app.unauthorized") {
            val world = World()
            val game = world.started()
            world.projectedGame = null

            world.ports.snapshot(game.gameId, game.facilitator).err() shouldBe AppFailure.Unauthorized
        }

        test("[US2.1] Given 取得 When 実行する Then 認証の後に、投影を 1 回だけ読む") {
            val world = World()
            val game = world.started()
            world.projectedGame = projectedOf(game, NAMES)
            world.clearCalls()

            world.ports.snapshot(game.gameId, game.facilitator).ok()

            world.calls shouldBe listOf("tx.begin", "authenticate", "tx.commit", "reader.read")
            world.calls.joinToString() shouldContain "reader.read"
        }

        // ---- B6 Step 3: 共同担当の保存者・時刻・共同担当の開示（AC2.2.1・AC2.2.4。表示名は同じ役割の共同担当と進行役にだけ） ----

        test("[B6/3.1a][US2.2/AC2.2.1] Given 二次卸に共同担当がいて、共同担当が保存した When 二次卸の参加者が取得する Then 保存者（表示名つき・自分でない）と保存の時刻が返る") {
            val world = World()
            val game = world.started()
            val coHolder = ParticipantId(UUID.randomUUID())
            val projected = withCoHolder(game, coHolder, Editor.ByParticipant(coHolder))

            val view =
                Disclosure
                    .forParticipant(
                        projected,
                        game.seats[Role.WHOLESALER].participantId,
                        null,
                    ).ok()
                    .participantView()

            val status = checkNotNull(view.status)
            status.decisionEditor shouldBe
                DecisionEditorView(EditorKind.PARTICIPANT, isSelf = false, displayName = CO_NAME)
            status.decisionSavedAt shouldBe SAVED_AT
        }

        test("[B6/3.1a][US2.2/AC2.2.1] Given 自分が保存した When 取得する Then 保存者は自分（isSelf）で、表示名は自分の表示名") {
            val world = World()
            val game = world.started()
            val self = game.seats[Role.WHOLESALER].participantId
            val projected = withCoHolder(game, ParticipantId(UUID.randomUUID()), Editor.ByParticipant(self))

            val status =
                checkNotNull(
                    Disclosure
                        .forParticipant(projected, self, null)
                        .ok()
                        .participantView()
                        .status,
                )

            status.decisionEditor shouldBe
                DecisionEditorView(EditorKind.PARTICIPANT, isSelf = true, displayName = NAMES.getValue(Role.WHOLESALER))
        }

        test("[B6/3.1a][US2.2/AC2.2.4] Given 進行役が代理入力した When 参加者が取得する Then 保存者は進行役（代理入力）で、表示名を持たず、自分でもない") {
            val world = World()
            val game = world.started()
            val projected = withCoHolder(game, ParticipantId(UUID.randomUUID()), Editor.ByFacilitator(game.gameId))

            val status =
                checkNotNull(
                    Disclosure
                        .forParticipant(
                            projected,
                            game.seats[Role.WHOLESALER].participantId,
                            null,
                        ).ok()
                        .participantView()
                        .status,
                )

            status.decisionEditor shouldBe
                DecisionEditorView(EditorKind.FACILITATOR_PROXY, isSelf = false, displayName = null)
        }

        test("[B6/3.1a] Given 入力がまだ無い役割 When 取得する Then 保存者と保存の時刻は無い（null）") {
            val world = World()
            val game = world.started()
            val projected = projectedOf(game, NAMES, decisions = emptyMap())

            val status =
                checkNotNull(
                    Disclosure
                        .forParticipant(
                            projected,
                            game.seats[Role.WHOLESALER].participantId,
                            null,
                        ).ok()
                        .participantView()
                        .status,
                )

            status.decisionEditor shouldBe null
            status.decisionSavedAt shouldBe null
        }

        test("[B6/3.1a][AC1.2.4] Given 二次卸に共同担当がいる When 二次卸の参加者が取得する Then 共同担当の一覧（表示名と自分かどうか）が返り、入れ替えで外れた旧担当者は含まれない") {
            val world = World()
            val game = world.started()
            val coHolder = ParticipantId(UUID.randomUUID())
            val old = ParticipantId(UUID.randomUUID())
            val projected =
                withCoHolder(game, coHolder, Editor.ByParticipant(coHolder)).let {
                    it.copy(participants = it.participants + ProjectedParticipant(old, "旧担当の太郎", null, replaced = true))
                }

            val view =
                Disclosure
                    .forParticipant(
                        projected,
                        game.seats[Role.WHOLESALER].participantId,
                        null,
                    ).ok()
                    .participantView()

            view.coHolders shouldContainExactly
                listOf(
                    CoHolderView(NAMES.getValue(Role.WHOLESALER), isSelf = true),
                    CoHolderView(CO_NAME, isSelf = false),
                )
        }

        test(
            "[B6/3.1b][US2.1/AC2.1.2] Given 二次卸の共同担当が保存した When 小売店の参加者が取得する Then 二次卸の保存者・表示名・保存の時刻・共同担当は、どの項目にも含まれない",
        ) {
            val world = World()
            val game = world.started()
            val coHolder = ParticipantId(UUID.randomUUID())
            val projected = withCoHolder(game, coHolder, Editor.ByParticipant(coHolder))

            val view =
                Disclosure
                    .forParticipant(
                        projected,
                        game.seats[Role.RETAILER].participantId,
                        null,
                    ).ok()
                    .participantView()

            val text = view.toString()
            text shouldNotContain CO_NAME
            text shouldNotContain NAMES.getValue(Role.WHOLESALER)
            text shouldNotContain SAVED_AT.toString()
            view.coHolders shouldContainExactly listOf(CoHolderView(NAMES.getValue(Role.RETAILER), isSelf = true))
            checkNotNull(view.status).decisionEditor shouldBe null
            checkNotNull(view.status).decisionSavedAt shouldBe null
        }

        test("[B6/3.1b] Given 役割のいない参加者（準備中の未割り当て）When 取得する Then 保存者・共同担当は返らない") {
            val world = World()
            val game = world.started()
            val coHolder = ParticipantId(UUID.randomUUID())
            val waiting = ParticipantId(UUID.randomUUID())
            val projected =
                withCoHolder(game, coHolder, Editor.ByParticipant(coHolder)).let {
                    it.copy(participants = it.participants + ProjectedParticipant(waiting, "待機の次郎", null))
                }

            val view = Disclosure.forParticipant(projected, waiting, null).ok().participantView()

            view.coHolders shouldBe emptyList()
            view.status shouldBe null
            view.toString() shouldNotContain CO_NAME
        }

        test("[B6/3.1d][US2.2] Given 進行役 When 取得する Then 役割ごとの保存者（表示名つき）と保存の時刻、ロビーに共同担当が同じ役割で並ぶ") {
            val world = World()
            val game = world.started()
            val coHolder = ParticipantId(UUID.randomUUID())
            val projected = withCoHolder(game, coHolder, Editor.ByParticipant(coHolder))

            val view = Disclosure.forFacilitator(projected).facilitatorView()

            val wholesaler = view.roles.getValue(Role.WHOLESALER)
            wholesaler.decisionEditor shouldBe
                DecisionEditorView(EditorKind.PARTICIPANT, isSelf = false, displayName = CO_NAME)
            wholesaler.decisionSavedAt shouldBe SAVED_AT
            view.roles.getValue(Role.RETAILER).decisionEditor shouldBe null
            view.lobby.filter { it.role == Role.WHOLESALER }.map { it.displayName } shouldContainExactly
                listOf(NAMES.getValue(Role.WHOLESALER), CO_NAME)
        }

        test("[B6/3.1a][US2.2/AC2.2.4] Given 進行役が代理入力した When 進行役が取得する Then 保存者は進行役（代理入力。isSelf）で、表示名は持たない") {
            val world = World()
            val game = world.started()
            val projected = withCoHolder(game, ParticipantId(UUID.randomUUID()), Editor.ByFacilitator(game.gameId))

            val view = Disclosure.forFacilitator(projected).facilitatorView()

            view.roles.getValue(Role.WHOLESALER).decisionEditor shouldBe
                DecisionEditorView(EditorKind.FACILITATOR_PROXY, isSelf = true, displayName = null)
        }

        test("[B6/3.1a] Given 二次卸の参加者の入力がある When 資格つきで取得する（ポート経由）Then 保存者と保存の時刻まで返る") {
            val world = World()
            val game = world.started()
            world.projectedGame = projectedOf(game, NAMES)

            val status =
                checkNotNull(
                    world.ports
                        .snapshot(game.gameId, game.seats[Role.WHOLESALER].credential)
                        .ok()
                        .participantView()
                        .status,
                )

            status.decisionEditor shouldBe
                DecisionEditorView(EditorKind.PARTICIPANT, isSelf = true, displayName = NAMES.getValue(Role.WHOLESALER))
            status.decisionSavedAt shouldBe SAVED_AT
        }
    })

private const val CO_NAME = "共同の花子"

/** 二次卸に共同担当 [coHolder]（[CO_NAME]）を足した投影。二次卸の入力は [editor] が [SAVED_AT] に保存した。 */
private fun withCoHolder(
    game: Prepared,
    coHolder: ParticipantId,
    editor: Editor,
): ProjectedGame =
    projectedOf(
        game,
        NAMES,
        decisions = mapOf(Role.WHOLESALER to ProjectedDecision(2, 3399, 5, editor, SAVED_AT)),
    ).let { it.copy(participants = it.participants + ProjectedParticipant(coHolder, CO_NAME, Role.WHOLESALER)) }
