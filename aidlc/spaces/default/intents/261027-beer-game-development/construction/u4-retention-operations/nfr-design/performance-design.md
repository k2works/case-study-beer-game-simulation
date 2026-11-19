# Performance Design - U4 Retention Operations

## Performance budgets

| Requirement | Design | Budget |
|---|---|---|
| NFR1.1 | status query は `deletion_saga` と `owner_deletion_progress` を `game_id` / `deletion_id` index で取得し、1 回の query で projection する | application 700 ms、database 250 ms、network 50 ms、p95 1 秒 |
| NFR1.2 | EventBridge が 5 分間隔で due policy を keyset pagination し、outbox 経由で SQS に投入する | rolling 30 日で due Saga の 99% を 24 時間以内に COMPLETED |
| NFR1.3 | 1 page 100 件、1 cycle の重複起動を advisory lock で抑止する | 15 team / 150% burst で 5 分以内 |

## Processing strategy

- scheduler transaction は Saga、owner progress、outbox を一括作成し、broker 障害を request path から分離します。
- worker は owner Unit ごとの queue を long polling し、game 単位の message group ではなく DB の current-attempt 条件更新で競合を制御します。
- status response は小さいため cache を置かず、強整合な PostgreSQL 読取を使用します。
- receipt cleanup は削除処理と別 batch にし、1,000 件単位の keyset pagination で実行します。

## Capacity verification

23 件の同時 due game、重複 delivery、owner latency、receipt 保存遅延を含む load test で p95、cycle duration、24 時間 SLI を測定します。

## Sources

- `nfr-requirements/performance-requirements.md`
- `nfr-design-questions.md` Q2

## Assumptions & Open Questions

None.
