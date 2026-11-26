-- V002: 周辺ストア（イベントに入れない値）。参加コードの索引、表示名、ブラウザセッション、冪等記録。
-- 資格の値は保存せず、ダイジェスト（SHA-256 の 16 進）だけを持つ（NF-S）。表示名はイベントに入れない（NF-S14）。

create table game_join_codes (
    join_code varchar(64) not null,
    game_id uuid not null,
    constraint pk_game_join_codes primary key (join_code),
    constraint fk_game_join_codes_game foreign key (game_id) references game_roots (game_id)
);

create table display_profiles (
    participant_id uuid not null,
    game_id uuid not null,
    display_name varchar(400) not null,
    constraint pk_display_profiles primary key (participant_id),
    constraint fk_display_profiles_game foreign key (game_id) references game_roots (game_id)
);

create table browser_sessions (
    token_digest varchar(64) not null,
    game_id uuid not null,
    subject_kind varchar(16) not null,
    subject_id uuid not null,
    expires_at timestamp with time zone not null,
    constraint pk_browser_sessions primary key (token_digest),
    constraint fk_browser_sessions_game foreign key (game_id) references game_roots (game_id),
    constraint ck_browser_sessions_kind check (subject_kind in ('facilitator', 'participant'))
);

create table idempotency_records (
    scope varchar(200) not null,
    idempotency_key varchar(200) not null,
    request_digest varchar(64) not null,
    status int not null,
    body text not null,
    constraint pk_idempotency_records primary key (scope, idempotency_key)
);
