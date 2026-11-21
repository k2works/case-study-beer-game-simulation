-- 0004: 投影（進行）。session_overview、role_current_states、current_decisions。

CREATE TABLE session_overview (
    game_id              uuid                     NOT NULL,
    status               text                     NOT NULL,
    week                 integer                  NOT NULL,
    submitted_role_count integer                  NOT NULL,
    started_at           timestamptz NOT NULL,
    ended_at             timestamptz,
    CONSTRAINT pk_session_overview PRIMARY KEY (game_id),
    CONSTRAINT fk_session_overview_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE,
    CONSTRAINT ck_session_overview_status CHECK (status IN ('ACTIVE', 'PAUSED', 'ENDED')),
    CONSTRAINT ck_session_overview_week CHECK (week > 0),
    CONSTRAINT ck_session_overview_submitted CHECK (submitted_role_count BETWEEN 0 AND 4)
);

-- 役割別の現在の状態。当該役割の参加者と進行役だけが読む（FR-04）。
-- shipment_pipeline は RoleState.deliveryPipeline。production_pipeline は、キットでは配送の待ち行列と同じなので B1 では書かない。
CREATE TABLE role_current_states (
    game_id               uuid         NOT NULL,
    role                  text         NOT NULL,
    inventory             integer      NOT NULL,
    backlog               integer      NOT NULL,
    order_pipeline        jsonb NOT NULL,
    shipment_pipeline     jsonb NOT NULL,
    production_pipeline   jsonb,
    cumulative_cost_minor bigint       NOT NULL,
    arrivals              integer      NOT NULL,
    orders                integer      NOT NULL,
    as_of_week            integer      NOT NULL,
    CONSTRAINT pk_role_current_states PRIMARY KEY (game_id, role),
    CONSTRAINT fk_role_current_states_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE,
    CONSTRAINT ck_role_current_states_role CHECK (role IN ('FACTORY', 'DISTRIBUTOR', 'WHOLESALER', 'RETAILER')),
    CONSTRAINT ck_role_current_states_units CHECK (inventory >= 0 AND backlog >= 0 AND arrivals >= 0 AND orders >= 0)
);

-- 当週の意思決定。確定で行を削除する。
CREATE TABLE current_decisions (
    game_id          uuid                     NOT NULL,
    role             text                     NOT NULL,
    week             integer                  NOT NULL,
    quantity         integer                  NOT NULL,
    decision_version bigint                   NOT NULL,
    editor_kind      text                     NOT NULL,
    editor_id        uuid                     NOT NULL,
    updated_at       timestamptz NOT NULL,
    CONSTRAINT pk_current_decisions PRIMARY KEY (game_id, role),
    CONSTRAINT fk_current_decisions_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE,
    CONSTRAINT ck_current_decisions_role CHECK (role IN ('FACTORY', 'DISTRIBUTOR', 'WHOLESALER', 'RETAILER')),
    CONSTRAINT ck_current_decisions_quantity CHECK (quantity >= 0 AND quantity <= 1000),
    CONSTRAINT ck_current_decisions_version CHECK (decision_version > 0)
);
