# Reliability Requirements - U2

## Consistency and recovery

- **NFR13.1** committed week、lifecycle transition、proxy decision は RPO 0 とします。
- **NFR13.2** application restart 後 15 minutes 以内に active session を復元します。
- **NFR13.3** state、audit、outbox は単一 PostgreSQL transaction で commit / rollback します。
- **NFR13.4** stale version、duplicate idempotency key、duplicate event を決定論的に拒否または再利用します。
- **NFR13.5** pause 中の拒否で existing draft を失いません。

## Verification

Container-backed PostgreSQL test で kill/restart、rollback、outbox replay、multi-tab conflict を検証します。

## Sources

`functional-design/rules.md`、`requirements.md`、U1 reliability design。
