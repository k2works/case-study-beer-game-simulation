-- V006: 観察者（B9）。観察用の招待コードはダイジェストだけを保存する（招待の ID と期限はイベントに残る）。
-- ブラウザセッションの種別に observer を足す（観察者は役割を持たず、復帰資格を持たない）。

create table observer_invitations (
    code_digest varchar(64) not null,
    game_id uuid not null,
    invitation_id uuid not null,
    constraint pk_observer_invitations primary key (code_digest),
    constraint uq_observer_invitations_id unique (invitation_id),
    constraint fk_observer_invitations_game foreign key (game_id) references game_roots (game_id)
);

alter table browser_sessions drop constraint ck_browser_sessions_kind;
alter table browser_sessions add constraint ck_browser_sessions_kind
    check (subject_kind in ('facilitator', 'participant', 'observer'));
