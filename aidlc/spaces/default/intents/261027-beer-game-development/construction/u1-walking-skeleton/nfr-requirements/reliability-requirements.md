# Reliability Requirements - u1-walking-skeleton

## Availability and Recovery

| ID | Requirement | Verification |
|---|---|---|
| NFR2.1 | monthly availability SLO は 99.5% とし、planned maintenance は事前通知した window のみ除外する。 | synthetic availability SLI |
| NFR2.2 | scheduled class / workshop session 中の complete outage または commit failure を 1 minute 以内に alert する。 | alert drill |
| NFR2.3 | committed week の RPO は 0 とし、acknowledged response は durable transaction commit 後にのみ返す。 | kill / restart fault test |
| NFR2.4 | application / database incident の RTO は 15 minutes とし、最後の committed week から再開できる。 | restore drill |
| NFR2.5 | week commit、idempotency record、WeekResult、outbox event は同一 transaction で all-or-nothing とする。 | transaction fault injection |
| NFR2.6 | same idempotency scope / key / payload の retry は 24 hours 同一結果を返し、異なる payload は conflict とする。 | retry / mismatch integration test |
| NFR2.7 | optimistic concurrency conflict は accepted write を失わず、latest safe state と version を返す。 | concurrent update test |

## Backup and Restore

- point-in-time recovery または同等機能により、acknowledged transaction を復元可能にします。
- restore drill は少なくとも release 前と backup policy 変更時に実施し、RPO / RTO evidence を保存します。
- SSE / polling failure は state mutation を妨げず、client は reconnect 後に authoritative version へ収束します。

## Graceful Degradation

- live update failure 時は polling fallback を提示し、入力中の値を保持します。
- database unavailable 時は mutation を受理済みと表示せず、retryable failure と correlation ID を返します。
- outbox delivery 遅延時も committed state は保持し、delivery lag を alert します。

## Sources

- `inception/requirements-analysis/requirements.md` NFR2
- `inception/contract-design/contract-summary.md`
- `construction/u1-walking-skeleton/functional-design/functional-spec.md`
- `construction/u1-walking-skeleton/nfr-requirements/nfr-requirements-questions.md`

## Assumptions & Open Questions

- concrete backup interval と database service は NFR Design / Infrastructure Design で決定します。
