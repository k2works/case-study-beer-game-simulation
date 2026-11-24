-- 0007: 参加・復帰の失敗の窓（NF-S11・NF-S19）。接続元の鍵付き要約ごとに、窓（固定長）の中の失敗の回数を数える。
-- 生の接続元（IP）は持たない。ゲームに属さない（連鎖削除の対象でない）。
-- アプリケーションは、検査の前に 1 を足し、認可の失敗でなければ 1 を戻す（0 になることがある）。
-- GRANT は、表を作ったこのマイグレーションに置く（0006 の方針: 表の後ろの番号に書く。既定の権限は与えない）。

CREATE TABLE participation_attempts (
    scope         text        NOT NULL,
    key_digest    text        NOT NULL,
    window_start  timestamptz NOT NULL,
    failure_count integer     NOT NULL,
    CONSTRAINT pk_participation_attempts PRIMARY KEY (scope, key_digest, window_start),
    CONSTRAINT ck_participation_attempts_scope CHECK (scope IN ('join', 'recover')),
    CONSTRAINT ck_participation_attempts_count CHECK (failure_count >= 0)
);

CREATE INDEX ix_participation_attempts_window ON participation_attempts (window_start);

GRANT SELECT, INSERT, UPDATE, DELETE ON participation_attempts TO beergame_writer;
