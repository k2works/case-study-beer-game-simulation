# Entity Model - u1-walking-skeleton

## Source of Truth

```yaml
entities:
  - name: GameConfiguration
    description: Game creation settings and participation identity.
    attributes:
      - {name: gameId, type: GameId, required: true, unique: true}
      - {name: name, type: Text, required: true, constraints: "trimmed, 1..100 visible characters"}
      - {name: joinCode, type: OpaqueCode, required: true, unique: true, constraints: "not logged or exported"}
      - {name: facilitatorCredentialDigest, type: CredentialDigest, required: true, unique: true}
      - {name: finalWeek, type: Integer, required: true, min: 1, max: 50}
      - {name: initialInventory, type: Quantity, required: true, min: 0}
      - {name: shipmentDelayWeeks, type: Integer, required: true, min: 2, max: 2}
      - {name: orderDelayWeeks, type: Integer, required: true, min: 2, max: 2}
      - {name: inventoryCostMinor, type: MoneyMinor, required: true, min: 0, default: 50}
      - {name: backlogCostMinor, type: MoneyMinor, required: true, min: 0, default: 100}
      - {name: quantityUpperBound, type: Quantity, required: true, min: 1, constraints: "safe system default; configurable per game"}
      - {name: demandSeries, type: "List<Quantity>", required: true, constraints: "length >= finalWeek"}
      - {name: kitConformance, type: Enum, required: true, allowed: [JSD_KIT, CUSTOM]}
      - {name: createdAt, type: Instant, required: true}
    constraints:
      - A JSD_KIT game uses the externally confirmed preset without modification.
      - Any change to the preset or initial values marks the game CUSTOM.
    relationships:
      - {target: Participation, cardinality: "1 to many", direction: owns}
      - {target: GameSession, cardinality: "1 to 1", direction: configures}

  - name: Participation
    description: One participant identity and its optional assigned supply-chain role.
    attributes:
      - {name: participantId, type: ParticipantId, required: true, unique: true}
      - {name: gameId, type: GameId, required: true, references: GameConfiguration.gameId}
      - {name: displayName, type: Text, required: true, constraints: "trimmed, 1..80 visible characters; markup escaped"}
      - {name: role, type: Enum, required: false, allowed: [FACTORY, DISTRIBUTOR, WHOLESALER, RETAILER]}
      - {name: recoveryCredentialDigest, type: CredentialDigest, required: true, unique: true}
      - {name: joinedAt, type: Instant, required: true}
      - {name: credentialStatus, type: Enum, required: true, allowed: [ACTIVE, REVOKED], default: ACTIVE}
    constraints:
      - The same participantId belongs to exactly one game.
      - Each of the four roles is assigned at most once per game in U1.
      - Raw credentials never persist and never appear in logs, URLs, or exports.
    relationships:
      - {target: GameConfiguration, cardinality: "many to 1", direction: belongs_to}
      - {target: RoleDecision, cardinality: "1 to many", direction: authors}

  - name: GameSession
    description: Aggregate root for synchronized weekly progression and durable simulation state.
    attributes:
      - {name: sessionId, type: SessionId, required: true, unique: true}
      - {name: gameId, type: GameId, required: true, unique: true, references: GameConfiguration.gameId}
      - {name: status, type: Enum, required: true, allowed: [LOBBY, ACTIVE, ENDED], default: LOBBY}
      - {name: currentWeek, type: Integer, required: true, min: 1, default: 1}
      - {name: version, type: Integer, required: true, min: 0, default: 0}
      - {name: roleStates, type: "Map<Role, RoleState>", required: true, constraints: "exactly four entries when ACTIVE"}
      - {name: shipmentPipelines, type: "Map<Role, DelayPipeline>", required: true}
      - {name: orderPipelines, type: "Map<Role, DelayPipeline>", required: true}
      - {name: cumulativeCostMinor, type: MoneyMinor, required: true, min: 0, default: 0}
      - {name: updatedAt, type: Instant, required: true}
    constraints:
      - Only the aggregate transaction may change weekly state, decisions, cost, and outbox events.
      - Inventory and backlog are non-negative integers after every committed week.
    relationships:
      - {target: GameConfiguration, cardinality: "1 to 1", direction: governed_by}
      - {target: RoleDecision, cardinality: "1 to many", direction: contains}
      - {target: WeekResult, cardinality: "1 to many", direction: produces}

  - name: RoleDecision
    description: One role's mutable order or production request for one uncommitted week.
    attributes:
      - {name: decisionId, type: DecisionId, required: true, unique: true}
      - {name: sessionId, type: SessionId, required: true, references: GameSession.sessionId}
      - {name: week, type: Integer, required: true, min: 1}
      - {name: role, type: Enum, required: true, allowed: [FACTORY, DISTRIBUTOR, WHOLESALER, RETAILER]}
      - {name: quantity, type: Quantity, required: true, min: 0}
      - {name: version, type: Integer, required: true, min: 1}
      - {name: submittedBy, type: ParticipantId, required: true, references: Participation.participantId}
      - {name: submittedAt, type: Instant, required: true}
      - {name: committed, type: Boolean, required: true, default: false}
    constraints:
      - Exactly one current decision exists for each session, week, and role.
      - A committed decision is immutable.
      - Quantity is at most GameConfiguration.quantityUpperBound.
    relationships:
      - {target: GameSession, cardinality: "many to 1", direction: belongs_to}
      - {target: Participation, cardinality: "many to 1", direction: submitted_by}

  - name: WeekResult
    description: Immutable result of one atomic weekly simulation step.
    attributes:
      - {name: sessionId, type: SessionId, required: true, references: GameSession.sessionId}
      - {name: week, type: Integer, required: true, min: 1}
      - {name: roleResults, type: "Map<Role, RoleWeekResult>", required: true}
      - {name: demand, type: Quantity, required: true, min: 0}
      - {name: weeklyCostMinor, type: MoneyMinor, required: true, min: 0}
      - {name: cumulativeCostMinor, type: MoneyMinor, required: true, min: 0}
      - {name: aggregateVersion, type: Integer, required: true, min: 1}
      - {name: committedAt, type: Instant, required: true}
    constraints:
      - The pair sessionId and week is unique.
      - Money uses integer minor units; quantity uses integer units.
    relationships:
      - {target: GameSession, cardinality: "many to 1", direction: result_of}

  - name: IdempotencyRecord
    description: Durable replay result for an accepted mutation.
    attributes:
      - {name: actorId, type: ActorId, required: true}
      - {name: operation, type: OperationId, required: true}
      - {name: resourceId, type: OpaqueId, required: true}
      - {name: idempotencyKeyDigest, type: Digest, required: true}
      - {name: requestDigest, type: Digest, required: true}
      - {name: responseReference, type: OpaqueReference, required: true}
      - {name: statusCode, type: Integer, required: true}
      - {name: expiresAt, type: Instant, required: true, constraints: "acceptedAt + 24 hours"}
    constraints:
      - The tuple actorId, operation, resourceId, and idempotencyKeyDigest is unique until expiry.
      - A reused key with a different requestDigest is a conflict.
    relationships: []

  - name: OutboxEvent
    description: Domain event committed atomically with GameSession changes.
    attributes:
      - {name: eventId, type: EventId, required: true, unique: true}
      - {name: aggregateId, type: SessionId, required: true, references: GameSession.sessionId}
      - {name: aggregateVersion, type: Integer, required: true, min: 1}
      - {name: eventType, type: Enum, required: true, allowed: [GameCreated, ParticipantJoined, RoleAssigned, DecisionSubmitted, WeekCommitted]}
      - {name: payload, type: VersionedData, required: true}
      - {name: correlationId, type: CorrelationId, required: true}
      - {name: occurredAt, type: Instant, required: true}
    constraints:
      - Event and aggregate state are committed in the same transaction.
      - Payload excludes credentials and unauthorized role-private values.
    relationships:
      - {target: GameSession, cardinality: "many to 1", direction: emitted_by}
```

## Entity Summary

`GameConfiguration` owns immutable game rules and credentials, `Participation` owns participant identity, and `GameSession` is the sole aggregate root for weekly state. `RoleDecision` remains editable only before commit; `WeekResult` is immutable. `IdempotencyRecord` protects mutation retries for 24 hours, while `OutboxEvent` preserves atomic state/event publication.

## Sources

- `inception/domain-design/components.md`
- `inception/requirements-analysis/requirements.md`
- `inception/user-stories/stories.md`
- `inception/units-generation/unit-of-work.md`
- `inception/contract-design/contract-summary.md`
- `construction/u1-walking-skeleton/functional-design/functional-design-questions.md`

## Assumptions & Open Questions

- `quantityUpperBound` の安全な既定値は NFR Design と implementation configuration で確定します。
- JSD preset の具体値は外部確認後に versioned fixture として固定します。
