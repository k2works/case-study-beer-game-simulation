package beergame.application

import arrow.core.Either
import arrow.core.raise.either
import arrow.core.raise.ensureNotNull
import beergame.domain.Actor
import beergame.domain.ActorRef
import beergame.domain.DisplayName
import beergame.domain.GameCommand
import beergame.domain.GameError
import beergame.domain.GameId
import beergame.domain.GameSettings
import beergame.domain.JoinCode
import beergame.domain.ParticipantId
import beergame.domain.RetentionDays
import beergame.domain.Role
import beergame.domain.RoleMap
import beergame.domain.SessionCommand
import beergame.domain.StartGame
import beergame.domain.ValidationError
import java.time.Duration

/*
 * B1 のユースケース。入力の形の検証（誤りは項目ごとにすべて集める）と、コマンドの組み立てだけを持つ。
 * 業務ルールは decide（domain）にあり、ここには無い。周辺ストアに書く行の導出は Credentials.kt。
 */

data class CreateGameInput(
    val finalWeek: Int,
    val demand: List<Int>,
    val retentionDays: Int,
)

data class JoinGameInput(
    val joinCode: String,
    val displayName: String,
)

data class SaveDecisionInput(
    val role: Role,
    val week: Int,
    val quantity: Int,
    val expectedDecisionVersion: Long,
)

data class CommitWeekInput(
    val requestedWeek: Int,
    val basis: RoleMap<Long>,
)

/** 代理入力の入力（B5）。画面が見ている週と、代わりに入力する数量。意思決定の版は要求しない。 */
data class ProxyDecisionInput(
    val role: Role,
    val requestedWeek: Int,
    val quantity: Int,
)

/** 現在の版の鍵で、新しい資格を作る。値は版の接頭辞つきで、応答だけが運ぶ。保存するのはダイジェストと版だけ。 */
internal suspend fun Ports.issue(
    kind: CredentialKind,
    actor: ActorRef,
): DigestedCredential {
    val minted = settings.credentialKeys.mint(newCredential())
    return DigestedCredential(minted.digest, minted.keyVersion, IssuedCredential(minted.raw, kind, actor))
}

/** ブラウザセッションと復帰資格を、別の乱数・別のダイジェストで、一度に発行する。 */
private suspend fun Ports.issuance(
    kind: CredentialKind,
    actor: ActorRef,
): Issuance = Issuance(session = issue(kind, actor), recovery = issue(kind, actor))

private fun generated(
    what: String,
    error: ValidationError,
): AppFailure = AppFailure.Persistence(PersistenceFailure("generate", "生成した$what が不正: $error"))

// ---- ゲームの作成 ----

/** キット準拠のゲームを作成する。進行役の資格を発行し、その生の値は応答だけが運ぶ（AC1.1.1）。 */
suspend fun Ports.createGame(
    input: CreateGameInput,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> =
    either {
        val (gameSettings, retention) =
            (GameSettings.kit(input.finalWeek, input.demand) and RetentionDays.of(input.retentionDays).nel())
                .mapLeft(AppFailure::Invalid)
                .bind()
        val gameId = GameId(newId())
        val joinCode = JoinCode.of(newJoinCode()).mapLeft { generated("参加コード", it) }.bind()
        val issuance = issuance(CredentialKind.FACILITATOR, Actor.Facilitator(gameId).toRef())
        val body = "kit|${input.finalWeek}|${input.demand.joinToString(",")}|${input.retentionDays}"
        val operation = Operation(gameId, IdempotencyKey.CREATE_SCOPE, body)
        val request =
            CommandRequest(
                operation,
                Auth.ANONYMOUS,
                STATUS_CREATED,
                meta,
                issued = { issuance.session.credential },
                recovery = { _, _ -> issuance.recovery.credential },
            )
        runCommand(request) { tx, ctx ->
            val expiresAt = ctx.at.plus(Duration.ofDays(retention.value.toLong()))
            val command =
                GameCommand.CreateGame(
                    ctx.actor,
                    ctx.at,
                    gameId,
                    joinCode,
                    gameSettings,
                    retention,
                    expiresAt,
                )
            applySingle(tx, ctx, gameStream, command) {
                peripheralWrites(gameId, command, issuance, settings.sessionTtl, ctx.at)
            }
        }.bind()
    }

// ---- 参加 ----

/**
 * 参加コードで参加する（認可は参加コード）。不明・形式不正の参加コードは区別せず `game.invitation_invalid`（AC1.2.2）。
 * 受付が終わったゲームは、decide が `game.not_preparing` を返す。復帰資格を発行し、表示名は周辺ストアにだけ書く。
 */
suspend fun Ports.joinGame(
    input: JoinGameInput,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> =
    either {
        val name =
            DisplayName
                .of(input.displayName)
                .nel()
                .mapLeft(AppFailure::Invalid)
                .bind()
        // 入力の検証（上）は、窓に数えない。参加コードの検査から先を、接続元ごとの窓で制限する（B5 Step 5）
        limitedAttempts(AttemptScope.JOIN, meta.source) { joinWithCode(input.joinCode, name, meta) }.bind()
    }

/** 参加コードを検査して参加する（窓で制限される部分）。不明・形式不正の参加コードは `game.invitation_invalid`（認可の失敗）。 */
private suspend fun Ports.joinWithCode(
    joinCode: String,
    name: DisplayName,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> =
    either {
        val code = JoinCode.of(joinCode).mapLeft { AppFailure.Domain(GameError.InvitationInvalid) }.bind()
        val found = events.transaction { tx -> peripheral.findGameByJoinCode(tx, code) }.bind()
        val gameId = ensureNotNull(found) { AppFailure.Domain(GameError.InvitationInvalid) }
        val participantId = ParticipantId(newId())
        val issuance = issuance(CredentialKind.PARTICIPANT_RECOVERY, Actor.Participant(participantId).toRef())
        val operation = Operation(gameId, SCOPE_JOIN, "join|${code.value}|${name.value}")
        val request =
            CommandRequest(
                operation,
                Auth.ANONYMOUS,
                STATUS_OK,
                meta,
                issued = { issuance.session.credential },
                recovery = { _, _ -> issuance.recovery.credential },
            )
        runCommand(request) { tx, ctx ->
            val expiresAt = ctx.at.plus(settings.participantCredentialTtl)
            val command = GameCommand.JoinGame(ctx.actor, ctx.at, participantId, name, expiresAt)
            applySingle(tx, ctx, gameStream, command) {
                peripheralWrites(gameId, command, issuance, settings.sessionTtl, ctx.at)
            }
        }.bind()
    }

// ---- 役割の割り当て・開始 ----

suspend fun Ports.assignRole(
    gameId: GameId,
    participantId: ParticipantId,
    role: Role,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> {
    val operation = Operation(gameId, "assign:${participantId.value}", "assign|${participantId.value}|${role.name}")
    val request = CommandRequest(operation, Auth.REQUIRED, STATUS_OK, meta)
    // 準備中は付け替え（D9。game だけ）、開始後は入れ替え（H4。game と session の 2 ストリーム）。呼び分けは applyAssign
    return runCommand(request) { tx, ctx ->
        applyAssign(tx, ctx, GameCommand.AssignRole(ctx.actor, ctx.at, participantId, role))
    }
}

/** ゲームを開始する。`game` と `session` の両ストリームへ、原子的に追記する。 */
suspend fun Ports.startGame(
    gameId: GameId,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> {
    val request = CommandRequest(Operation(gameId, SCOPE_START, SCOPE_START), Auth.REQUIRED, STATUS_OK, meta)
    return runCommand(request) { tx, ctx -> applyStart(tx, ctx, StartGame(ctx.actor, ctx.at)) }
}

// ---- 入力の保存・確定 ----

/** 当週の数量を保存する（session ストリーム）。数量・週・版の形の誤りは、すべて集める（AC2.2.2）。 */
suspend fun Ports.saveDecision(
    gameId: GameId,
    input: SaveDecisionInput,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> =
    either {
        val (week, quantity, expected) = validateSave(input).mapLeft(AppFailure::Invalid).bind()
        val body = "decision|${input.role.name}|${input.week}|${input.quantity}|${input.expectedDecisionVersion}"
        val operation = Operation(gameId, "decision:${input.role.name}", body)
        val request = CommandRequest(operation, Auth.REQUIRED, STATUS_OK, meta)
        var actor: Actor = Actor.Anonymous
        runCommand(request) { tx, ctx ->
            actor = ctx.actor
            val command = SessionCommand.SaveDecision(ctx.actor, ctx.at, input.role, week, quantity, expected)
            applySingle(tx, ctx, sessionStream, command)
        }.withConflictDetail(this@saveDecision, gameId, actor).bind()
    }

/** 1 週を確定する（session ストリーム）。判定の順（週 → 根拠の版 → 入力の揃い）は decide が持つ。 */
suspend fun Ports.commitWeek(
    gameId: GameId,
    input: CommitWeekInput,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> =
    either {
        val (week, basis) = validateCommit(input).mapLeft(AppFailure::Invalid).bind()
        val versions = Role.entries.joinToString(",") { "${it.name}=${input.basis[it]}" }
        val operation = Operation(gameId, "commit:${input.requestedWeek}", "commit|${input.requestedWeek}|$versions")
        val request = CommandRequest(operation, Auth.REQUIRED, STATUS_OK, meta)
        var actor: Actor = Actor.Anonymous
        runCommand(request) { tx, ctx ->
            actor = ctx.actor
            applySingle(tx, ctx, sessionStream, SessionCommand.CommitWeek(ctx.actor, ctx.at, week, basis))
        }.withConflictDetail(this@commitWeek, gameId, actor).bind()
    }

private const val SCOPE_JOIN = "join"
private const val SCOPE_START = "start"
private const val STATUS_OK = 200
private const val STATUS_CREATED = 201
