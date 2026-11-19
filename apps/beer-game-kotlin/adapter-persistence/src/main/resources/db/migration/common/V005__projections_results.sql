-- 005: 投影（結果）。week_commits、week_role_results、week_team_totals。
-- week_team_totals（観察者向けのチーム合計）は、表は作るが B1 では書かない（判断項目 #12。B9 で書く）。

CREATE TABLE week_commits (
    game_id        uuid                     NOT NULL,
    week           integer                  NOT NULL,
    commit_kind    text                     NOT NULL,
    contributors   integer                  NOT NULL,
    stream_version bigint                   NOT NULL,
    committed_at   timestamp with time zone NOT NULL,
    -- 週は一度だけ確定される（主キーが 2 つ目の防壁）。
    CONSTRAINT pk_week_commits PRIMARY KEY (game_id, week),
    CONSTRAINT fk_week_commits_game FOREIGN KEY (game_id) REFERENCES game_roots (game_id) ON DELETE CASCADE,
    CONSTRAINT ck_week_commits_kind CHECK (commit_kind IN ('MANUAL', 'AUTO')),
    CONSTRAINT ck_week_commits_week CHECK (week BETWEEN 1 AND 50)
);

CREATE TABLE week_role_results (
    game_id               uuid    NOT NULL,
    week                  integer NOT NULL,
    role                  text    NOT NULL,
    demand                integer NOT NULL,
    shipped               integer NOT NULL,
    ordered               integer NOT NULL,
    ending_inventory      integer NOT NULL,
    ending_backlog        integer NOT NULL,
    weekly_cost_minor     integer NOT NULL,
    cumulative_cost_minor bigint  NOT NULL,
    CONSTRAINT pk_week_role_results PRIMARY KEY (game_id, week, role),
    CONSTRAINT fk_week_role_results_commit FOREIGN KEY (game_id, week) REFERENCES week_commits (game_id, week) ON DELETE CASCADE,
    CONSTRAINT ck_week_role_results_role CHECK (role IN ('FACTORY', 'DISTRIBUTOR', 'WHOLESALER', 'RETAILER'))
);

CREATE TABLE week_team_totals (
    game_id         uuid    NOT NULL,
    week            integer NOT NULL,
    total_ordered   integer NOT NULL,
    total_inventory integer NOT NULL,
    total_backlog   integer NOT NULL,
    contributors    integer NOT NULL,
    CONSTRAINT pk_week_team_totals PRIMARY KEY (game_id, week),
    CONSTRAINT fk_week_team_totals_commit FOREIGN KEY (game_id, week) REFERENCES week_commits (game_id, week) ON DELETE CASCADE
);
