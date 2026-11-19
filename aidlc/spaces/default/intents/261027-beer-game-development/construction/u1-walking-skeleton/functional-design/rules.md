# Business Rules - u1-walking-skeleton

## Source of Truth

```yaml
rules:
  - id: BR1.1
    statement: A valid game is created exactly once with a unique join code and separate facilitator credential.
    category: constraint
    applies_to: GameConfiguration
    trigger: createGame
    logic: IF settings and demand series are valid and the idempotency key is new THEN create one game and session in LOBBY.
    violation: Return field-specific validation or idempotency conflict without creating partial data.
    source: [FR1.1, FR1.2, FR1.3, FR1.4, NFR2, NFR3]
  - id: BR1.2
    statement: Kit conformance is explicit and never inferred after preset modification.
    category: policy
    applies_to: GameConfiguration
    trigger: createGame
    logic: IF any confirmed JSD preset value is changed THEN kitConformance is CUSTOM; otherwise it is JSD_KIT.
    violation: Reject a request that claims JSD_KIT while values differ from the versioned preset.
    source: [FR1.2, FR1.4]
  - id: BR1.3
    statement: Demand and decision quantities are bounded non-negative integers.
    category: validation
    applies_to: GameConfiguration, RoleDecision
    trigger: createGame or submitRoleDecision
    logic: IF a quantity is not an integer in 0..quantityUpperBound or the demand series is shorter than finalWeek THEN reject it and retain the submitted values for correction.
    violation: Return the field, offending week when applicable, inclusive bound, and correction guidance.
    source: [FR1.3, FR4.2, FR4.3]
  - id: BR2.1
    statement: Joining requires a valid active join code and produces a distinct participant recovery token.
    category: authorization
    applies_to: Participation
    trigger: joinGame
    logic: IF the join code resolves to a LOBBY game THEN create one participant and return the raw recovery token once.
    violation: Reveal no secret or game existence beyond the documented not-found response.
    source: [FR2.1, FR2.2, NFR3, NFR4]
  - id: BR2.2
    statement: Four supply-chain roles are unique within a game and all are required before start.
    category: constraint
    applies_to: Participation, GameSession
    trigger: assignRole or startSession
    logic: IF a role is already assigned THEN reject the duplicate; IF any role is missing THEN reject session start and list missing roles to the facilitator.
    violation: Preserve existing assignments and session status.
    source: [FR2.3]
  - id: BR3.1
    statement: Every read and write is authorized for the target game and role on the server.
    category: authorization
    applies_to: GameConfiguration, Participation, GameSession, RoleDecision, WeekResult
    trigger: every command and query
    logic: IF actor credential, game membership, role, and operation do not match THEN return forbidden or not found without protected data.
    violation: Return RFC 9457 problem details with correlationId and no credential or private value.
    source: [FR3.1, FR3.2, FR3.4, NFR3]
  - id: BR3.2
    statement: A participant state response contains only the participant role's operational state.
    category: authorization
    applies_to: GameSession
    trigger: getRoleSafeState
    logic: IF the actor is a participant THEN include own inventory, backlog, arrivals, current order, allowed history, shared week and completion status only.
    violation: Omit other-role values and future demand at serialization time.
    source: [FR3.1, FR3.2]
  - id: BR4.1
    statement: One current decision exists per role and week and stale edits never overwrite newer ones.
    category: constraint
    applies_to: RoleDecision
    trigger: submitRoleDecision
    logic: IF expectedVersion equals current version and the week is open THEN replace the current value and increment version; otherwise reject as stale and return the latest safe state.
    violation: Return precondition failed or business conflict without changing the decision.
    source: [FR2.4, FR4.2, FR4.5]
  - id: BR4.2
    statement: A week is committed only by the facilitator after all four valid decisions exist.
    category: policy
    applies_to: GameSession, RoleDecision
    trigger: commitWeek
    logic: IF actor is facilitator, status is ACTIVE, expectedVersion is current, and four role decisions exist THEN run the weekly calculation; otherwise reject and identify missing roles or invalid state.
    violation: Make no weekly state change.
    source: [FR4.1, FR4.4, FR4.5]
  - id: BR4.3
    statement: Mutation retries are idempotent for the same actor, operation, resource, key, and payload for 24 hours.
    category: policy
    applies_to: IdempotencyRecord
    trigger: createGame, joinGame, submitRoleDecision, commitWeek
    logic: IF a matching unexpired record and request digest exist THEN return the recorded result; IF payload differs THEN return conflict.
    violation: Never repeat the side effect and never replace the original record.
    source: [FR1.1, FR4.4, NFR2]
  - id: BR5.1
    statement: Weekly simulation follows the 12-step order with two-week order, shipment, and production delays.
    category: calculation
    applies_to: GameSession, WeekResult
    trigger: commitWeek
    logic: IF a week is eligible THEN SimulationEngine consumes the prior state, current demand, and four decisions and returns the next state without side effects.
    violation: Abort the commit if any input or pipeline invariant is invalid.
    source: [FR4.1, FR5.1, FR5.5]
  - id: BR5.2
    statement: Shipment, inventory, and backlog are calculated without negative balances.
    category: calculation
    applies_to: GameSession, WeekResult
    trigger: commitWeek
    logic: available equals prior inventory plus arrivals; obligation equals prior backlog plus current order; shipment equals min(available, obligation); ending inventory equals available minus shipment; ending backlog equals obligation minus shipment.
    violation: Reject an impossible state before persistence.
    source: [FR5.2, FR5.3]
  - id: BR5.3
    statement: Weekly cost uses integer minor units and is deterministic.
    category: calculation
    applies_to: WeekResult
    trigger: commitWeek
    logic: weekly cost equals ending inventory times inventoryCostMinor plus ending backlog times backlogCostMinor for all roles; cumulative cost adds the prior cumulative value.
    violation: Reject overflow or non-integer input and persist no partial result.
    source: [FR5.4, FR5.5]
  - id: BR6.1
    statement: Week state, decisions, result, idempotency record, and outbox events commit atomically.
    category: constraint
    applies_to: GameSession, RoleDecision, WeekResult, IdempotencyRecord, OutboxEvent
    trigger: commitWeek
    logic: IF every calculation and invariant succeeds THEN persist all changes in one transaction; otherwise persist none.
    violation: Return a retryable failure with correlationId and leave the prior committed week unchanged.
    source: [FR4.4, FR6.3, FR6.4, NFR2]
```

## Rules Summary

| Group | Purpose | Key rules |
|---|---|---|
| BR1 | Game creation and input validity | Exactly-once creation, explicit kit status, bounded integers |
| BR2 | Participation | Safe join and unique four-role assignment |
| BR3 | Information control | Per-object authorization and role-safe serialization |
| BR4 | Decision and commit control | Optimistic concurrency, facilitator commit, 24-hour idempotency |
| BR5 | Simulation calculation | 12-step delays, non-negative balances, integer-minor cost |
| BR6 | Reliability | Atomic state, result, idempotency, and outbox persistence |

## Sources

- `inception/requirements-analysis/requirements.md`
- `inception/user-stories/stories.md`
- `inception/domain-design/components.md`
- `inception/contract-design/contract-summary.md`
- `construction/u1-walking-skeleton/functional-design/functional-design-questions.md`

## Assumptions & Open Questions

- facilitator explicit commit is the only U1 transition from four completed decisions to a committed week.
- timeout budget and credential entropy are specified in NFR Requirements / NFR Design.
