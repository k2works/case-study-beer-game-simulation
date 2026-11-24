-- 0009: 保持と削除（B12。US5.1、NFR-07）。retention_policies（GameCreated の投影）と、削除の手続き（RetentionSaga）の状態。
-- retention_policies は game_roots の連鎖削除の対象（game_id を持つ全表の 1 つ）。
-- deletion_runs・deletion_attempts は、**game_roots へ外部キーを持たない**（ゲームのデータが消えた後も、再試行の記録として
-- 生き残るため）。完了のトランザクションで、この 2 表の行も削除し、game_id を含む行を残さない。
-- deletion_receipts は、ゲームを特定しない証跡（game_id を持たない。ゲームの ID の鍵付き HMAC のダイジェストだけ）。1 年後に削除する。
-- GRANT は、表を作ったこのマイグレーションに置く（0006 の方針）。既定の権限は与えない。

CREATE TABLE retention_policies (
    game_id             uuid        NOT NULL,
    retention_days      integer     NOT NULL,
    retention_starts_at timestamptz NOT NULL,
    delete_after        timestamptz NOT NULL,
    CONSTRAINT pk_retention_policies PRIMARY KEY (game_id),
    CONSTRAINT fk_retention_policies_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE,
    CONSTRAINT ck_retention_policies_days CHECK (retention_days BETWEEN 1 AND 3650),
    CONSTRAINT ck_retention_policies_period CHECK (delete_after > retention_starts_at)
);

-- 期限到来の検出。
CREATE INDEX ix_retention_policies_due ON retention_policies (delete_after, game_id);

-- 削除の進行。status が FAILED で next_attempt_at が無いものは、再試行の上限に達して、再試行をやめた状態。
-- IN_PROGRESS の next_attempt_at は、貸出の期限（これを過ぎても完了が記録されなければ、停止とみなして再開する）。
CREATE TABLE deletion_runs (
    deletion_id       uuid        NOT NULL,
    game_id           uuid        NOT NULL,
    status            text        NOT NULL,
    attempt           integer     NOT NULL,
    requested_at      timestamptz NOT NULL,
    next_attempt_at   timestamptz,
    last_failure_code text,
    CONSTRAINT pk_deletion_runs PRIMARY KEY (deletion_id),
    CONSTRAINT uq_deletion_runs_game UNIQUE (game_id),
    CONSTRAINT ck_deletion_runs_status CHECK (status IN ('PENDING', 'IN_PROGRESS', 'FAILED', 'COMPLETED')),
    CONSTRAINT ck_deletion_runs_attempt CHECK (attempt >= 0)
);

CREATE TABLE deletion_attempts (
    deletion_id  uuid        NOT NULL,
    attempt      integer     NOT NULL,
    started_at   timestamptz NOT NULL,
    failure_code text,
    CONSTRAINT pk_deletion_attempts PRIMARY KEY (deletion_id, attempt),
    CONSTRAINT fk_deletion_attempts_run FOREIGN KEY (deletion_id) REFERENCES deletion_runs (deletion_id) ON DELETE CASCADE,
    CONSTRAINT ck_deletion_attempts_attempt CHECK (attempt >= 1)
);

CREATE TABLE deletion_receipts (
    deletion_id           uuid        NOT NULL,
    game_reference_digest text        NOT NULL,
    outcome               text        NOT NULL,
    recorded_at           timestamptz NOT NULL,
    expires_at            timestamptz NOT NULL,
    CONSTRAINT pk_deletion_receipts PRIMARY KEY (deletion_id),
    CONSTRAINT ck_deletion_receipts_digest CHECK (char_length(game_reference_digest) = 64),
    CONSTRAINT ck_deletion_receipts_outcome CHECK (outcome IN ('COMPLETED')),
    CONSTRAINT ck_deletion_receipts_expiry CHECK (expires_at > recorded_at)
);

-- 期限切れの受領記録の掃除。
CREATE INDEX ix_deletion_receipts_expiry ON deletion_receipts (expires_at);

-- 書き込み（api）: retention_policies は GameCreated の投影（再構築が行を消すので DELETE も与える）。deletion_* には与えない。
GRANT SELECT, INSERT, UPDATE, DELETE ON retention_policies TO beergame_writer;

-- 読み取り（api の問い合わせ。保持状態）: 方針と、削除の進行の状態だけ。受領記録・試行履歴は読めない。
GRANT SELECT ON retention_policies, deletion_runs TO beergame_reader;

-- 削除（retention モード）: 期限の検出（retention_policies の SELECT）、削除の進行の記録、受領記録の挿入と期限切れの掃除。
-- game_roots の SELECT・DELETE は 0006。連鎖削除の子の表（events ほか）の DELETE 権限は、要らない（0006 の注記）。
GRANT SELECT ON retention_policies TO beergame_deleter;
GRANT SELECT, INSERT, UPDATE, DELETE ON deletion_runs, deletion_attempts TO beergame_deleter;
GRANT SELECT, INSERT, DELETE ON deletion_receipts TO beergame_deleter;
