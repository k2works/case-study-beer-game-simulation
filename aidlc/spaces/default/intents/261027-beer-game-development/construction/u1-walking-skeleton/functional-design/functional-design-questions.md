# Functional Design Questions - u1-walking-skeleton

## Q1 Week commit trigger

4 役割の decision が揃った後、week commit をどのように開始しますか？

- A. Facilitator explicit commit
- B. Automatic commit
- C. Configurable per game
- X. Other (please specify)

[Answer]: A. Facilitator explicit commit

## Q2 Actor credentials

account login を使わずに、facilitator と participant の command authorization をどの credential で区別しますか？

- A. Facilitator secret + participant recovery token
- B. Shared game secret + role token
- C. Join code only
- X. Other (please specify)

[Answer]: A. Facilitator secret + participant recovery token

## Q3 Quantity upper bound

発注数・生産要請数の functional upper bound をどうしますか？

- A. Configurable per game with safe default
- B. Fixed system-wide bound
- C. Data-type bound only
- X. Other (please specify)

[Answer]: A. Configurable per game with safe default

## Q4 Idempotency scope

同じ `Idempotency-Key` を異なる payload で再利用した場合の扱いと、結果を再利用できる期間をどうしますか？

- A. Actor + operation + resource scope、24 hours、payload mismatch は conflict
- B. Game-wide scope、game 終了まで、payload mismatch は conflict
- C. Resource version scope、version 更新まで、payload mismatch は conflict
- X. Other (please specify)

[Answer]: A. Actor + operation + resource scope、24 hours、payload mismatch は conflict

## Q5 Concurrent decision edits

同一 role の複数 participant が同時に編集した場合、どの値を正としますか？

- A. Optimistic concurrency; stale update rejected
- B. Last-write-wins with notification
- C. Explicit edit lock
- X. Other (please specify)

[Answer]: A. Optimistic concurrency; stale update rejected

## Sources

- `inception/units-generation/unit-of-work.md`
- `inception/units-generation/unit-of-work-story-map.md`
- `inception/user-stories/stories.md`
- `inception/requirements-analysis/requirements.md`
- `inception/domain-design/components.md`
- `inception/contract-design/contract-summary.md`

## Assumptions & Open Questions

- JSD preset の具体値は外部確認待ちであり、custom series により Functional Design を進めます。
- None.
