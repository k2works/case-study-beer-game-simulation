# Reliability Requirements - U4 Retention Operations

## SLO and recovery

| ID | Requirement | Target |
|---|---|---|
| NFR2.1 | C4/C5 の重複 delivery は同一 deletion result を返す | duplicate execution で追加削除・状態退行 0 件 |
| NFR2.2 | retryable failure は同じ deletionId で最大 5 回、指数 backoff + jitter で再試行する | attempt ledger |
| NFR2.3 | permanent failure または retry 枯渇時は FAILED で停止する | COMPLETED 誤判定 0 件 |
| NFR2.4 | 全 required owner 完了と receipt 永続化を満たすまで COMPLETED にしない | failure-injection test |
| NFR2.5 | restart 後に現在の Saga、owner progress、retry schedule を復元する | restart recovery test |

## Failure semantics

完了済み owner は再試行で巻き戻さず、未完 owner だけを対象にします。旧 attempt の遅延 completion は current attempt を更新してはなりません。

## Sources

- `functional-design/rules.md` BR15.2〜BR15.6
- `requirements.md` NFR2
