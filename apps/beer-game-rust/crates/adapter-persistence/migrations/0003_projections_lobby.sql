-- 0003: 投影（準備）。game_overview、game_join_codes、game_settings、lobby_*。
-- 観察者向けの lobby_observer_invitations と lobby_observers は、B9 まで書かない（Rust 版の B2 の範囲外）。
-- キット準拠では、イベントに載らない列（初期条件、遅延、公開範囲）は NULL を許す（カスタム条件は B7）。

CREATE TABLE game_overview (
    game_id          uuid                     NOT NULL,
    status           text                     NOT NULL,
    final_week       integer                  NOT NULL,
    commit_mode      text                     NOT NULL,
    settings_kind    text                     NOT NULL,
    settings_changes jsonb             NOT NULL,
    retention_days   integer                  NOT NULL,
    created_at       timestamptz NOT NULL,
    started_at       timestamptz,
    ended_at         timestamptz,
    CONSTRAINT pk_game_overview PRIMARY KEY (game_id),
    CONSTRAINT fk_game_overview_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE,
    CONSTRAINT ck_game_overview_status CHECK (status IN ('PREPARING', 'STARTED', 'ENDED')),
    CONSTRAINT ck_game_overview_final_week CHECK (final_week BETWEEN 1 AND 50),
    CONSTRAINT ck_game_overview_commit_mode CHECK (commit_mode IN ('MANUAL', 'AUTO')),
    CONSTRAINT ck_game_overview_settings_kind CHECK (settings_kind IN ('KIT', 'CUSTOM')),
    CONSTRAINT ck_game_overview_retention CHECK (retention_days BETWEEN 1 AND 3650)
);

-- 参加コード。観察者のロールには SELECT を与えない（BR-17。権限は PostgreSQL の V101 で B2）。
CREATE TABLE game_join_codes (
    game_id   uuid NOT NULL,
    join_code text NOT NULL,
    CONSTRAINT pk_game_join_codes PRIMARY KEY (game_id),
    CONSTRAINT uq_game_join_codes_code UNIQUE (join_code),
    CONSTRAINT fk_game_join_codes_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE
);

CREATE TABLE game_settings (
    game_id              uuid         NOT NULL,
    demand               jsonb NOT NULL,
    initial_conditions   jsonb,
    holding_cost_minor   integer      NOT NULL,
    backlog_cost_minor   integer      NOT NULL,
    order_delay_weeks    integer,
    shipment_delay_weeks integer,
    production_delay_weeks integer,
    disclosure_policy    text,
    CONSTRAINT pk_game_settings PRIMARY KEY (game_id),
    CONSTRAINT fk_game_settings_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE,
    CONSTRAINT ck_game_settings_costs CHECK (holding_cost_minor >= 0 AND backlog_cost_minor >= 0),
    CONSTRAINT ck_game_settings_delays CHECK (
        COALESCE(order_delay_weeks, 0) >= 0 AND COALESCE(shipment_delay_weeks, 0) >= 0 AND COALESCE(production_delay_weeks, 0) >= 0
    )
);

-- (game_id, role) の一意制約は無い（共同担当を許すため。FR-16）。
CREATE TABLE lobby_participants (
    participant_id uuid                     NOT NULL,
    game_id        uuid                     NOT NULL,
    role           text,
    joined_at      timestamptz NOT NULL,
    CONSTRAINT pk_lobby_participants PRIMARY KEY (participant_id),
    CONSTRAINT fk_lobby_participants_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE,
    CONSTRAINT ck_lobby_participants_role CHECK (role IS NULL OR role IN ('FACTORY', 'DISTRIBUTOR', 'WHOLESALER', 'RETAILER'))
);

CREATE TABLE lobby_observer_invitations (
    invitation_id uuid                     NOT NULL,
    game_id       uuid                     NOT NULL,
    expires_at    timestamptz NOT NULL,
    revoked_at    timestamptz,
    created_at    timestamptz NOT NULL,
    CONSTRAINT pk_lobby_observer_invitations PRIMARY KEY (invitation_id),
    CONSTRAINT fk_lobby_observer_invitations_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE
);

CREATE TABLE lobby_observers (
    observer_id   uuid                     NOT NULL,
    game_id       uuid                     NOT NULL,
    invitation_id uuid                     NOT NULL,
    joined_at     timestamptz NOT NULL,
    CONSTRAINT pk_lobby_observers PRIMARY KEY (observer_id),
    CONSTRAINT fk_lobby_observers_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE
);
