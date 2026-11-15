-- 008: 参加・復帰の失敗の窓（B5 Step 5。NF-S11・NF-S19）。総当たりで参加コード・復帰資格を当てられないようにする。
-- 窓の数は DB にあるので、複数のインスタンス（タスク）で合算される（プロセス内の制限は、タスク数だけ実効の上限が増える）。
--
-- 接続元の鍵 key_digest は、**正規化した接続元の鍵付き要約**（HMAC-SHA256、16 進 64 桁）。生の IP アドレスは持たない。
-- ゲームに属さない表（game_id を持たず、game_roots の連鎖削除の対象でない）。窓が終わった行は、アプリケーションが
-- 新しい窓の最初の記録のときに掃除する（window_start の索引で、古い行を探す）。
-- 窓は、窓の幅（設定値）で切り捨てた開始時刻（window_start）で区切る。failure_count は、その窓の認可の失敗の数
-- （アプリケーションは、検査の前に 1 を足し、認可の失敗でなければ 1 を戻す。0 になることがある）。
-- GRANT は PostgreSQL 専用の 102（DB ロールと GRANT）に書く。共通のマイグレーションには、ロールが無い H2 でも通る DDL だけを置く。

CREATE TABLE participation_attempts (
    scope         text                     NOT NULL,
    key_digest    text                     NOT NULL,
    window_start  timestamp with time zone NOT NULL,
    failure_count integer                  NOT NULL,
    CONSTRAINT pk_participation_attempts PRIMARY KEY (scope, key_digest, window_start),
    CONSTRAINT ck_participation_attempts_scope CHECK (scope IN ('join', 'recover')),
    CONSTRAINT ck_participation_attempts_count CHECK (failure_count >= 0)
);

CREATE INDEX ix_participation_attempts_window ON participation_attempts (window_start);
