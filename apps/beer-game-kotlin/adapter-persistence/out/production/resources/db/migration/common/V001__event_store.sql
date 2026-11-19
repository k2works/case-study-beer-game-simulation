-- 001: イベントストアの土台。game_roots（連鎖削除の根）、events（追記専用の正本）、projection_checkpoints。
-- PostgreSQL 18 と H2（PostgreSQL モード。ローカル開発専用）の両方で動く DDL だけを書く。
-- 方言で型が違う列は Flyway のプレースホルダ（${json_type}）で切り替える。timestamptz は H2 で通る `timestamp with time zone` と書く。

CREATE TABLE game_roots (
    game_id    uuid                     NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_game_roots PRIMARY KEY (game_id)
);

CREATE TABLE events (
    event_id       uuid                     NOT NULL,
    seq            bigint                   GENERATED ALWAYS AS IDENTITY,
    game_id        uuid                     NOT NULL,
    stream_type    text                     NOT NULL,
    stream_version bigint                   NOT NULL,
    event_type     text                     NOT NULL,
    schema_version integer                  NOT NULL,
    payload        ${json_type}             NOT NULL,
    actor_kind     text                     NOT NULL,
    actor_id       uuid,
    correlation_id uuid                     NOT NULL,
    command_id     uuid                     NOT NULL,
    occurred_at    timestamp with time zone NOT NULL,
    CONSTRAINT pk_events PRIMARY KEY (event_id),
    CONSTRAINT uq_events_seq UNIQUE (seq),
    -- 楽観的並行制御。同じストリームの同じ版への追記は、この制約の違反になる（ConcurrencyConflict）。
    CONSTRAINT uq_events_stream_version UNIQUE (game_id, stream_type, stream_version),
    CONSTRAINT fk_events_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE,
    CONSTRAINT ck_events_stream_type CHECK (stream_type IN ('GAME', 'SESSION')),
    CONSTRAINT ck_events_stream_version CHECK (stream_version >= 1),
    CONSTRAINT ck_events_schema_version CHECK (schema_version >= 1)
);

CREATE TABLE projection_checkpoints (
    game_id           uuid                     NOT NULL,
    stream_type       text                     NOT NULL,
    projected_version bigint                   NOT NULL,
    updated_at        timestamp with time zone NOT NULL,
    CONSTRAINT pk_projection_checkpoints PRIMARY KEY (game_id, stream_type),
    CONSTRAINT fk_projection_checkpoints_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE,
    CONSTRAINT ck_projection_checkpoints_stream_type CHECK (stream_type IN ('GAME', 'SESSION')),
    CONSTRAINT ck_projection_checkpoints_version CHECK (projected_version >= 0)
);
