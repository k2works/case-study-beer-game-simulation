-- V003（PostgreSQL 専用。H2 では適用しない）: ロールと権限。イベントは追記専用にする（AC: 追記専用権限の否定テスト）。
-- 書き込みロールには SELECT と INSERT だけを与え、UPDATE・DELETE・TRUNCATE は与えない。
-- ロールはクラスターに 1 つ。すでにあれば作らない（テストでスキーマごとに適用するため）。

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'bgs_event_writer') then
        create role bgs_event_writer nologin;
    end if;
end
$$;

grant usage on schema ${flyway:defaultSchema} to bgs_event_writer;

grant select, insert on game_roots to bgs_event_writer;

grant select, insert on events to bgs_event_writer;
