# Business Rules - U2 Session Continuity

## Lifecycle rules

- **BR7.1** `RUNNING -> PAUSED -> RUNNING` と `RUNNING|PAUSED -> ENDED` のみ許可します。
- **BR7.2** PAUSED 中の participant decision 確定と week commit は拒否し、既存 draft を保持します。
- **BR7.3** resume 後は最後の committed week の次週から入力を再開します。
- **BR7.4** ENDED は終端状態であり、decision、proxy decision、resume を拒否します。

## Proxy and audit rules

- **BR8.1** proxy decision は facilitator のみ実行でき、対象 role、期待 version、理由を必須とします。
- **BR8.2** proxy decision と audit / outbox は同じ transaction で保存します。
- **BR8.3** proxy decision は通常 decision と同じ quantity validation と stale-version rejection を適用します。

## Recovery rules

- **BR9.1** recovery token は高 entropy random value とし、digest match、有効期限、失効状態、game / role membership をすべて検証します。
- **BR9.2** invalid、expired、revoked、deleted token は同じ unauthorized response とし、token の存在を漏らしません。
- **BR9.3** 再接続 response は current stateVersion と role-safe latest state を返します。
- **BR9.4** token rotation は新 token の digest 保存と旧 token 失効を同一 transaction で行います。

## Concurrency and recovery rules

- **BR10.1** mutation は `expectedVersion` を要求し、不一致なら `409 STALE_STATE` と current version を返します。
- **BR10.2** client は version が小さい response / SSE event を適用しません。
- **BR10.3** restart 後は PostgreSQL の committed aggregate と outbox から復元し、in-memory state を authority にしません。
- **BR10.4** idempotency key の再送は同じ result を返し、異なる payload は conflict とします。

## Sources

- `inception/user-stories/stories.md` AC3.1.1〜AC3.2.3
- `inception/requirements-analysis/requirements.md`
- `inception/contract-design/contract-summary.md`
- `construction/u1-walking-skeleton/functional-design/rules.md`

## Assumptions & Open Questions

- None.
