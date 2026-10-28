# Contract Summary - ビールゲームシミュレーション

## Contracts

| # | Provider Unit | Consumer | Mechanism | Owner |
|---|---|---|---|---|
| C1 | U1 `u1-walking-skeleton` | External: browser UI / U5 | JSON REST/HTTP v1 | U1 |
| C2 | U1 `u1-walking-skeleton` | U2 `u2-session-continuity` | in-process application interface v1 | U1 |
| C3 | U1 `u1-walking-skeleton` | U3 `u3-learning-view` | AsyncAPI domain events v1 | U1 |
| C4 | U4 `u4-retention-operations` | U1、U2、U3 | AsyncAPI deletion events v1 | U4 |
| C5 | U1、U2、U3 | U4 `u4-retention-operations` | AsyncAPI deletion completion v1 | U4 |
| C6 | U3 `u3-learning-view` | External: browser UI / U5 | JSON REST/HTTP v1 | U3 |

## C1 - Game API

U1 は game creation、join、role-safe state、decision、week commit を提供します。すべての mutation は `Idempotency-Key`、versioned resource の更新は `If-Match` を受け取ります。

```yaml
openapi: 3.1.0
info: {title: Beer Game API, version: 1.0.0}
servers: [{url: /api/v1}]
paths:
  /games:
    post:
      operationId: createGame
      parameters:
        - {in: header, name: Idempotency-Key, required: true, schema: {type: string}}
      responses:
        '201': {description: Created}
        '400': {$ref: '#/components/responses/Problem'}
        '409': {$ref: '#/components/responses/Problem'}
  /games/{gameId}/participants:
    post:
      operationId: joinGame
      parameters:
        - {in: path, name: gameId, required: true, schema: {type: string}}
        - {in: header, name: Idempotency-Key, required: true, schema: {type: string}}
      responses:
        '201': {description: Joined}
        '404': {$ref: '#/components/responses/Problem'}
        '409': {$ref: '#/components/responses/Problem'}
  /sessions/{sessionId}/state:
    get:
      operationId: getRoleSafeState
      parameters:
        - {in: path, name: sessionId, required: true, schema: {type: string}}
      responses:
        '200': {description: State filtered for the authenticated game and role}
        '403': {$ref: '#/components/responses/Problem'}
  /sessions/{sessionId}/decisions:
    put:
      operationId: submitRoleDecision
      parameters:
        - {in: path, name: sessionId, required: true, schema: {type: string}}
        - {in: header, name: If-Match, required: true, schema: {type: string}}
        - {in: header, name: Idempotency-Key, required: true, schema: {type: string}}
      responses:
        '200': {description: Accepted}
        '409': {$ref: '#/components/responses/Problem'}
        '412': {$ref: '#/components/responses/Problem'}
  /sessions/{sessionId}/weeks/{week}/commit:
    post:
      operationId: commitWeek
      parameters:
        - {in: path, name: sessionId, required: true, schema: {type: string}}
        - {in: path, name: week, required: true, schema: {type: integer}}
        - {in: header, name: Idempotency-Key, required: true, schema: {type: string}}
        - {in: header, name: If-Match, required: true, schema: {type: string}}
      responses:
        '200': {description: Committed once; retries return the same result}
        '409': {$ref: '#/components/responses/Problem'}
        '412': {$ref: '#/components/responses/Problem'}
components:
  responses:
    Problem:
      description: RFC 9457 problem details with correlationId and no secret/token
```

### Failure contract

- validation は `400`、authorization は存在を秘匿できる `403` / `404`、business conflict は `409`、stale version は `412` とします。
- client timeout 後は同じ idempotency key で再送し、server は同じ status と result reference を返します。
- response と log に recovery token、credential digest、未来需要、他役割の非公開値を含めません。

## C2 - Session Continuity Interface

U2 は U1 の public module interface を利用し、table や aggregate を直接更新しません。

```yaml
shared-schema: 1.0.0
owner: u1-walking-skeleton
operations:
  - name: loadSessionForCommand
    input: [sessionId, actorContext, expectedVersion]
    output: [sessionSnapshot, authorizationDecision]
    errors: [NotFound, Forbidden, VersionConflict]
  - name: appendSessionTransition
    input: [sessionId, transition, idempotencyKey, expectedVersion]
    output: [newVersion, emittedEventIds]
    errors: [InvalidTransition, VersionConflict, PersistenceUnavailable]
rules:
  - every write uses the owning aggregate and transaction boundary
  - callers never read or write owner tables directly
```

## C3 - Game Domain Events

GameSession の state change と outbox row は同じ transaction で commit します。U3 は `eventId` で重複排除し、`sessionId + aggregateVersion` で順序を検査します。

```yaml
asyncapi: 3.0.0
info: {title: Beer Game Domain Events, version: 1.0.0}
channels:
  gameEvents:
    address: beer-game.game.v1
    messages:
      GameChanged:
        payload:
          type: object
          required: [eventId, eventType, occurredAt, correlationId, gameId, sessionId, aggregateVersion, schemaVersion, data]
          properties:
            eventId: {type: string}
            eventType: {enum: [GameCreated, ParticipantJoined, RoleAssigned, DecisionSubmitted, WeekCommitted, SessionPaused, SessionResumed, SessionEnded]}
            occurredAt: {type: string, format: date-time}
            correlationId: {type: string}
            gameId: {type: string}
            sessionId: {type: string}
            aggregateVersion: {type: integer}
            schemaVersion: {const: 1}
            data: {type: object, additionalProperties: true}
operations:
  publishGameChanged: {action: send, channel: {$ref: '#/channels/gameEvents'}}
  consumeGameChanged: {action: receive, channel: {$ref: '#/channels/gameEvents'}}
```

### Delivery contract

- delivery は at-least-once、producer retry は backoff、consumer は `eventId` で冪等化します。
- version gap は projection 更新を停止し、欠落 event の replay または session snapshot から rebuild します。
- unknown additive field は無視し、unknown major schema version は dead-letter 相当へ隔離します。

## C4 / C5 - Retention Deletion Saga

U4 が game-scoped deletion を開始し、owner Unit は自身の data だけを冪等に削除して completion を返します。

```yaml
asyncapi: 3.0.0
info: {title: Beer Game Deletion Contracts, version: 1.0.0}
channels:
  deletionRequested:
    address: beer-game.deletion.requested.v1
    messages:
      DeletionRequested:
        payload:
          type: object
          required: [eventId, deletionId, gameId, requestedAt, attempt, schemaVersion]
          properties:
            eventId: {type: string}
            deletionId: {type: string}
            gameId: {type: string}
            requestedAt: {type: string, format: date-time}
            attempt: {type: integer, minimum: 1}
            schemaVersion: {const: 1}
  deletionCompleted:
    address: beer-game.deletion.completed.v1
    messages:
      DeletionCompleted:
        payload:
          type: object
          required: [eventId, deletionId, ownerUnit, status, completedAt, schemaVersion]
          properties:
            eventId: {type: string}
            deletionId: {type: string}
            ownerUnit: {enum: [u1-walking-skeleton, u2-session-continuity, u3-learning-view]}
            status: {enum: [completed, retryable-failure, permanent-failure]}
            completedAt: {type: string, format: date-time}
            failureCode: {type: string}
            schemaVersion: {const: 1}
```

- U4 は全 owner Unit の `completed` を受けるまで完了としません。
- completion event は個人情報、token、削除対象 data を含めません。
- retry は同じ `deletionId` を使い、owner Unit は既に削除済みでも `completed` を返します。

## C6 - Learning API

```yaml
openapi: 3.1.0
info: {title: Beer Game Learning API, version: 1.0.0}
servers: [{url: /api/v1}]
paths:
  /games/{gameId}/observation:
    get:
      operationId: getObservation
      responses:
        '200': {description: Privacy-safe team totals with suppression reasons}
        '403': {description: Forbidden}
  /games/{gameId}/review:
    get:
      operationId: getEndedGameReview
      responses:
        '200': {description: Ended-game time series}
        '409': {description: Game has not ended}
  /games/{gameId}/exports:
    post:
      operationId: createExport
      parameters:
        - {in: header, name: Idempotency-Key, required: true, schema: {type: string}}
      responses:
        '202': {description: Complete export generation accepted}
        '403': {description: Forbidden}
```

U3 は U1 / U2 から渡された検証済み actor context を信用せず、query ごとに game membership、role、session status を server 側で再検査します。

## Contract Ownership and Change Policy

- provider Unit が spec と compatibility test を所有し、consumer Unit は contract test fixture を所有します。
- additive optional field は minor version とし、consumer は unknown field を無視します。
- required field の追加、意味変更、削除は major version とし、旧 major を少なくとも 1 release window 併存させます。
- API / event の schema と example は CI で lint し、provider と consumer の contract test を merge 前に実行します。
- correlation ID をすべての HTTP response と event に伝播します。

## Open Questions

| Contract | Question | Blocks |
|---|---|---|
| C1 | quantity 上限値と JSD preset の確定値 | U1 Functional Design |
| C1 / C6 | credential entropy、expiry、rotation | U1/U2 NFR Design |
| C3 | outbox dispatcher の具体的な実装と lag alert threshold | U3 NFR Design |
| C4 / C5 | deletion receipt の entity owner と保存期間 | U4 Functional / NFR Design |

## Sources

- `aidlc/spaces/default/intents/261027-beer-game-development/inception/units-generation/unit-of-work.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/units-generation/unit-of-work-dependency.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/domain-design/components.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/requirements-analysis/requirements.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/contract-design/contract-design-questions.md`

## Assumptions & Open Questions

- concrete framework、serialization library、broker / dispatcher は後続設計で選定します。
- Open Questions table の unresolved points は、それぞれ記載した後続 stage で数値または owner を確定します。
