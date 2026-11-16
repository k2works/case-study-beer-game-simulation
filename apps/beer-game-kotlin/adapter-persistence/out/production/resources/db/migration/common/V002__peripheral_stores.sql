-- 002: 周辺ストア。表示名・資格のダイジェスト・ブラウザセッション・冪等記録（イベントには入れない値）。

CREATE TABLE display_profiles (
    game_id      uuid                     NOT NULL,
    actor_kind   text                     NOT NULL,
    actor_id     uuid                     NOT NULL,
    display_name text                     NOT NULL,
    created_at   timestamp with time zone NOT NULL,
    CONSTRAINT pk_display_profiles PRIMARY KEY (game_id, actor_kind, actor_id),
    CONSTRAINT fk_display_profiles_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE
);

CREATE TABLE credentials (
    credential_digest text                     NOT NULL,
    game_id           uuid                     NOT NULL,
    kind              text                     NOT NULL,
    subject_id        uuid                     NOT NULL,
    key_version       integer                  NOT NULL,
    issued_at         timestamp with time zone NOT NULL,
    expires_at        timestamp with time zone NOT NULL,
    revoked_at        timestamp with time zone,
    CONSTRAINT pk_credentials PRIMARY KEY (credential_digest),
    CONSTRAINT fk_credentials_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE
);

CREATE TABLE browser_sessions (
    credential_digest text                     NOT NULL,
    game_id           uuid                     NOT NULL,
    actor_kind        text                     NOT NULL,
    actor_id          uuid                     NOT NULL,
    key_version       integer                  NOT NULL,
    expires_at        timestamp with time zone NOT NULL,
    CONSTRAINT pk_browser_sessions PRIMARY KEY (credential_digest),
    CONSTRAINT fk_browser_sessions_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE
);

-- 冪等記録。成功した応答だけを、暗号化して保存する。24 時間（expires_at）。
-- ゲーム作成（scope = 'create'）の同時の重複は、PostgreSQL では V102 の部分一意索引 uq_idempotency_create で検出する
-- （H2 では部分一意索引が使えないので、アプリケーション側で再照合する）。
CREATE TABLE idempotency_records (
    game_id        uuid                     NOT NULL,
    scope          text                     NOT NULL,
    key_digest     text                     NOT NULL,
    request_digest text                     NOT NULL,
    status_code    integer                  NOT NULL,
    response       bytea                    NOT NULL,
    expires_at     timestamp with time zone NOT NULL,
    CONSTRAINT pk_idempotency_records PRIMARY KEY (game_id, scope, key_digest),
    CONSTRAINT fk_idempotency_records_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE
);
