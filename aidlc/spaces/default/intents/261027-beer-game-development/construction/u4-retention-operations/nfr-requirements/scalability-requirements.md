# Scalability Requirements - U4 Retention Operations

## Capacity

| ID | Requirement | Target |
|---|---|---|
| NFR1.4 | 15 team の通常運用と 150% burst を処理する | 23 concurrent due games |
| NFR1.5 | owner Unit ごとの削除 worker を独立に増減できる | queue depth に基づく水平 scale |
| NFR8.1 | 1 game の再試行が他 game の削除を阻害しない | game-scoped work isolation |

## Growth

receipt は 1 年で期限切れとし、Saga と progress は gameId/deletionId で partition 可能な形を保ちます。

## Sources

- `functional-design/functional-spec.md`
- `requirements.md` NFR1、NFR8
