-- V001: イベントストア（追記専用の正本）。PostgreSQL と H2（PostgreSQL モード）の共通の DDL。
-- 追記専用の権限（ロールと GRANT）は PostgreSQL 専用の後続の番号で与える（B2）。
-- payload は text（JSON の文字列）。H2 は jsonb への cast で JSON の「文字列値」にしてしまうため、共通の text にする。

create table game_roots (
    game_id uuid not null,
    created_at timestamp with time zone not null default current_timestamp,
    constraint pk_game_roots primary key (game_id)
);

create table events (
    event_id uuid not null,
    game_id uuid not null,
    stream_type varchar(16) not null,
    stream_version bigint not null,
    schema_version int not null,
    event_type varchar(64) not null,
    payload text not null,
    occurred_at timestamp with time zone not null,
    constraint pk_events primary key (event_id),
    constraint uq_events_stream_version unique (game_id, stream_type, stream_version),
    constraint fk_events_game_root foreign key (game_id) references game_roots (game_id),
    constraint ck_events_stream_type check (stream_type in ('game', 'session')),
    constraint ck_events_version_positive check (stream_version >= 1)
);
