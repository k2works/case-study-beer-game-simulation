# Performance Design - U3 Learning View

## Architecture

- PostgreSQL read models use `(game_id, source_version)` and `(game_id, week, role)` indexes; API reads never join U1 owner tables.
- Event consumption and export generation are asynchronous. HTTP export creation only validates, snapshots `sourceVersion`, and enqueues work.
- CSV/JSON stream from one immutable canonical row iterator; no whole-file buffering.
- PostgreSQL pool: 5 warm / 20 maximum connections per instance, 5-second acquisition timeout. Query budget is 700 ms, leaving 300 ms for authentication and serialization.
- No cache initially. Add cache-aside only after load tests show database pressure, with a 5-second TTL and event-driven invalidation.

## Validation

Load tests exercise NFR1.1–NFR1.4 at 100% and 150% capacity and retain privacy and completeness checks.

## Sources

- `performance-requirements.md`
- `scalability-requirements.md`
