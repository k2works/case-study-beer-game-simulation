-- V004: 復帰資格（再接続・失効・再発行。AC3.2.*）。資格の値は保存せず、ダイジェストだけを持つ（NF-S）。
-- 失効は revoked を立てる（行は残す。区別せず 403 にするため、検索の条件に入れる）。

create table recovery_credentials (
    token_digest varchar(64) not null,
    game_id uuid not null,
    subject_kind varchar(16) not null,
    subject_id uuid not null,
    expires_at timestamp with time zone not null,
    revoked boolean not null default false,
    constraint pk_recovery_credentials primary key (token_digest),
    constraint fk_recovery_credentials_game foreign key (game_id) references game_roots (game_id),
    constraint ck_recovery_credentials_kind check (subject_kind in ('facilitator', 'participant'))
);

create index ix_recovery_credentials_subject on recovery_credentials (game_id, subject_kind, subject_id);
