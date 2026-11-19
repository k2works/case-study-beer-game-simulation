package beergame.persistence

/** 一意制約の名前の正本（data-model.md「一意制約の衝突の扱い」）。 */
internal object ConstraintNames {
    const val EVENTS_STREAM_VERSION = "uq_events_stream_version"
    const val IDEMPOTENCY_CREATE = "uq_idempotency_create"
    const val IDEMPOTENCY_PK = "pk_idempotency_records"

    /** 再試行（記録の再照合を含む）の対象にする制約。これ以外の一意制約の違反は、設計上起きないはずなので 500 にする。 */
    val retryable = listOf(EVENTS_STREAM_VERSION, IDEMPOTENCY_CREATE, IDEMPOTENCY_PK)
}

/** このアダプターが解釈する SQLSTATE。 */
internal object SqlStates {
    const val UNIQUE_VIOLATION = "23505"
    const val SERIALIZATION_FAILURE = "40001"
    const val DEADLOCK = "40P01"
    const val LOCK_NOT_AVAILABLE = "55P03"
}
