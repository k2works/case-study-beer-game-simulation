package beergame.application

import arrow.core.Either
import arrow.core.raise.either
import arrow.core.raise.ensure
import arrow.core.raise.ensureNotNull
import beergame.domain.Actor
import beergame.domain.GameId
import java.time.Instant

/** 削除の状態（進行役の画面 S09）。削除が完了したゲームは、記録ごと無いので、完了の値は無い。 */
enum class RetentionStatus {
    /** 期限の前、または期限に達したが、まだ試行していない。 */
    SCHEDULED,
    IN_PROGRESS,

    /** 直前の試行が失敗し、次の試行の時刻を待っている。 */
    RETRY_PENDING,

    /** 再試行の上限に達して、再試行をやめた（運営者への連絡が要る）。 */
    ABANDONED,
}

/**
 * 保持状態（`GET /games/{id}/retention`。B11）。[backupRetentionDays] は、削除の後も、自動バックアップに削除前のデータが残る
 * 最大の日数（AC5.1.5。運営者へ示す）。保持の起点は、暫定で作成時（M5）。
 */
data class RetentionView(
    val retentionDays: Int,
    val startsAt: Instant,
    val deleteAfter: Instant,
    val status: RetentionStatus,
    val attempt: Int,
    val nextAttemptAt: Instant?,
    val lastFailureCode: String?,
    val backupRetentionDays: Int = BACKUP_RETENTION_DAYS,
) {
    companion object {
        /** バックアップに削除前のデータが残る最大の日数（運用要件。バックアップの保持期間）。 */
        const val BACKUP_RETENTION_DAYS = 7
    }
}

/**
 * 保持状態の問い合わせ。**進行役だけ**。参加者・観察者・無資格・別のゲーム・存在しないゲームは、区別せず
 * [AppFailure.Unauthorized]（存在を明かさない）。方針の行が無いゲームは、投影の欠けとして失敗にする。
 */
suspend fun Ports.retention(
    gameId: GameId,
    credential: String?,
): Either<AppFailure, RetentionView> =
    either {
        val at = now()
        val verified = events.transaction { tx -> verifiedSession(tx, credential, at) }.bind()
        ensure(verified.gameId == gameId) { AppFailure.Unauthorized }
        ensure(verified.actor is Actor.Facilitator) { AppFailure.Unauthorized }
        val game = ensureNotNull(reader.read(gameId).bind()) { AppFailure.Unauthorized }
        val retention =
            ensureNotNull(game.retention) {
                AppFailure.Persistence(PersistenceFailure("retention.missing", "保持方針の行が無い"))
            }
        retention.toView()
    }

private fun ProjectedRetention.toView(): RetentionView {
    val current = run
    return RetentionView(
        retentionDays = retentionDays,
        startsAt = startsAt,
        deleteAfter = deleteAfter,
        status = current.statusOf(),
        attempt = current?.attempt ?: 0,
        nextAttemptAt = current?.nextAttemptAt?.takeIf { current.status == "FAILED" },
        lastFailureCode = current?.lastFailureCode,
    )
}

private fun ProjectedDeletionRun?.statusOf(): RetentionStatus =
    when {
        this == null || status == "PENDING" -> RetentionStatus.SCHEDULED
        status == "IN_PROGRESS" -> RetentionStatus.IN_PROGRESS
        nextAttemptAt == null -> RetentionStatus.ABANDONED
        else -> RetentionStatus.RETRY_PENDING
    }
