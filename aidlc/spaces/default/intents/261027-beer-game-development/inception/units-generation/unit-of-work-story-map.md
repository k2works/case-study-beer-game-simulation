# Unit to Story Map

## Story assignment

| Story | Primary Unit | Directory | Additional Unit(s) | Within-unit implementation scope |
|---|---|---|---|---|
| US1.1 | U1 | `u1-walking-skeleton` | U5; U4 | U1 game creation、U5 refined form、U4 retention setting |
| US1.2 | U1 | `u1-walking-skeleton` | U2; U5 | U1 join/role、U2 recovery、U5 lobby UI |
| US2.1 | U1 | `u1-walking-skeleton` | U5 | role-safe query の後に accessible play view |
| US2.2 | U1 | `u1-walking-skeleton` | U2; U5 | decision input、conflict handling、refined interaction |
| US2.3 | U1 | `u1-walking-skeleton` | U5 | pure calculation、atomic commit、confirm UI |
| US3.1 | U2 | `u2-session-continuity` | U5 | pause/proxy/resume/end、その後 facilitator UI |
| US3.2 | U2 | `u2-session-continuity` | U5 | credential recovery、multi-tab state、reconnect UI |
| US4.1 | U3 | `u3-learning-view` | U5 | privacy-safe observation projection と画面 |
| US4.2 | U3 | `u3-learning-view` | U5 | review projection、chart/table、ended authorization |
| US4.3 | U3 | `u3-learning-view` | U5 | CSV/JSON generation、download state UI |
| US5.1 | U4 | `u4-retention-operations` | U5 | deletion saga、receipt、retention status UI |

## Cross-cutting assignment

- U1〜U4 は各 capability の BDD、Unit Test、Integration Test を実装します。
- U5 は全 story の keyboard、focus、contrast、non-color state、responsive acceptance を実装します。
- U1 が outbox identity と module authorization convention を定義し、U2〜U4 が同じ convention を使用します。

## Coverage Verification

- upstream story 11 件はすべて primary Unit に割り当て済みです。
- U1〜U5 はすべて 1 件以上の story に割り当てられています。
- 複数 Unit の row は同じ story の application capability と UI / lifecycle 拡張を明示します。

## Sources

- `unit-of-work.md`
- `unit-of-work-dependency.md`
- `stories.md`
- `requirements.md`

## Assumptions & Open Questions

- story の acceptance criteria を Unit ごとの Functional Design へ分割する際、primary Unit が end-to-end outcome の統合責任を持ちます。

