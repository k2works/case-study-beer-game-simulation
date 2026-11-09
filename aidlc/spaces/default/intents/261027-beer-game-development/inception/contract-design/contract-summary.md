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
| C7 | U2 `u2-session-continuity` | External: browser UI / U5 | JSON REST/HTTP v1 | U2 |
| C8 | U4 `u4-retention-operations` | External: browser UI / U5 | JSON REST/HTTP v1 | U4 |
| C9 | U1 `u1-walking-skeleton` | External: browser UI / U5 | SSE + JSON snapshot v1 | U1 |

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

### Export completion and download

| Operation | Response | Authorization | Failure |
|---|---|---|---|
| `POST /games/{gameId}/exports` with `Idempotency-Key` | `202` `{exportId,status,schemaVersion,sourceVersion}` | facilitator cookie、game scope | `401` / `403` / `409` problem details |
| `GET /games/{gameId}/exports/{exportId}` | `200` `{exportId,status,schemaVersion,sourceVersion,checksum?}` | 同じ facilitator と game scope | `404`、未完成は status `PENDING` / `FAILED` を返す |
| `GET /games/{gameId}/exports/{exportId}/download?format=csv\|json` | 完成時のみ `200` と完全な body | 同じ facilitator と game scope | 未完成 `409`、存在しない ID `404` |

download response は `Cache-Control: no-store` と `Content-Disposition: attachment` を持ちます。部分生成した CSV / JSON は公開しません。

## Browser authentication and CSRF profile

U1〜U4 の browser 操作は同一 HTTPS origin で実行します。U2 が 256-bit の opaque `bg_session` を `HttpOnly; Secure; SameSite=Strict; Path=/` cookie で発行します。server は session の digest と actor scope を照合し、raw value を response body、URL、log、export に含めません。参加復帰資格は別の `HttpOnly; Secure; SameSite=Strict` cookie とし、復帰操作で rotation します。ゲーム終了と削除で資格を失効します。

`POST`、`PUT`、`PATCH`、`DELETE` は `Origin` と設定済み origin の完全一致を要求します。`Origin` が欠けた場合だけ HTTPS `Referer` の origin を比較し、両方欠落、`null`、異なる origin は `403 ORIGIN_REJECTED` です。CSRF token は使用しません。既存 U1 NFR Design の token 記述はこの browser profile に置き換えます。すべての失敗は RFC 9457 problem details と `correlationId` を返し、secret を含めません。

## C7 - Browser Session Continuity API

| Operation | Request | Response | Authorization / failure |
|---|---|---|---|
| `POST /participations/join` | `{joinCode,displayName}`、`Idempotency-Key`、`Origin` | `201` `{gameId,sessionId,participantId}` と HttpOnly session / recovery cookie | 不明な code は `404 JOIN_CODE_NOT_FOUND`、closed lobby は `409 JOIN_CLOSED` |
| `GET /games/{gameId}/lobby` | session cookie | `200` `{gameId,sessionId,week,status,version,participants,joinCode?}`。`joinCode` は facilitator のみ | game scope、未認証 `401`、他 game `403` |
| `POST /participations/recover` | 復帰 cookie、`Origin` | `200` `{gameId,state}` と rotated session / recovery cookie | 復帰資格が無効・期限切れ・削除済みなら同じ `401 RECOVERY_NOT_AVAILABLE` |
| `PUT /games/{gameId}/participants/{participantId}/role` | `{role}`、`Idempotency-Key`、`If-Match` | `200` `{participantId,role,version}` | facilitator cookie、game scope。重複役割 `409`、stale `412` |
| `POST /sessions/{sessionId}/start\|pause\|resume\|end` | `Idempotency-Key`、`If-Match`、`Origin` | `200` `{status,version}` | facilitator cookie、session scope。遷移不能 `409`、stale `412` |
| `PUT /sessions/{sessionId}/proxy-decisions/{role}` | `{quantity,expectedVersion}`、`Idempotency-Key`、`Origin` | `200` `{role,quantity,version,proxied}` | facilitator cookie、session scope。stale `412` |

認可は server が毎回行います。client の role 表示は認可の代替ではありません。mutation は同じ idempotency key の再送で同じ結果を返します。

## C8 - Browser Retention API

| Operation | Response | Authorization / failure |
|---|---|---|
| `GET /games/{gameId}/retention` | `200` `{policy:{gameId,retentionDays,retentionStartsAt,deleteAfter,policyVersion},deletion:{deletionId,status,attempt,owners,failureCode?}\|null}` | operator cookie と game scope。未認証 `401`、権限なし `403`、存在なし `404` |
| `POST /games/{gameId}/retention/retry` with `Idempotency-Key` / `If-Match` / `Origin` | `200` `{deletionId,status,attempt,owners}` | operator cookie と game scope。`If-Match` は現在の `attempt`、非 FAILED `409`、stale `412` |

`COMPLETED` は全 owner 完了と receipt 保存後のみ返します。`FAILED` は未完 owner と failure code を示し、receipt に個人情報を含めません。

## C9 - Live Browser State

`GET /games/{gameId}/events` は credential 付き SSE です。購読時と再接続時に game / role を認可します。event は `id: eventId`、`event: state-version`、`data: {gameId,version,correlationId}` のみとし、private state を含めません。client は `Last-Event-ID` を送って欠落通知を replay し、cursor が失効した場合は role-safe snapshot を再取得します。heartbeat は 15 秒以内、切断時は 1 秒 polling です。

snapshot は `GET /sessions/{sessionId}/state` の `200` `{sessionId,week,status,version,decisionComplete,decisionVersion,own}` です。`decisionVersion` は `PUT /decisions` の `If-Match` に使います。`own` は認証 role の値だけを含み、他 role と未来需要を含めません。SSE 中の commit-to-render p95 は 2 秒、fallback は 4 秒以内で測ります。client 側の version は単調増加とします。測定は同一 browser clock で commit button activation から応答を DOM に反映した時点までを 1 操作として記録し、server/network/render の span は診断用に分離します。75 user / 15 game の histogram で p95 を判定します。

## C10 - Shared API Task Consistency

すべての API task は同じ PostgreSQL を正本とし、ALB の sticky session を要求しません。game / session / participant / decision / week result / command idempotency / outbox event は game row の排他 transaction で更新します。作成 request の idempotency key は game identity がない段階で advisory transaction lock を取り、同じ key の再送は同じ game と暗号化保存された発行済み資格に対応します。cookie は digest と actor scope、期限を共有 DB で照合し、raw token は DB の平文列に保存しません。

SSE の `Last-Event-ID` は永続 outbox から task に依存せず再生します。`LISTEN/NOTIFY` は低遅延の hint とし、通知欠落時も version 順の再照会で補います。U3 の observation / review は永続 event から再構成でき、export package と同じ idempotency key の結果は共有 DB に保存します。異なる task で作成、参加、週確定、復帰、再接続、download を行う contract test を provider / consumer の双方で維持します。

## Edge forwarding contract

CloudFront は静的 asset を private S3 へ、`/api/*` と SSE 経路を ALB へ送ります。API / SSE は cache 無効です。`GET`、`POST`、`PUT`、`PATCH`、`DELETE`、`OPTIONS` を必要な path のみに許可し、`Cookie`、`Origin`、`Referer`、`Idempotency-Key`、`If-Match`、`Last-Event-ID`、query string を転送します。`Set-Cookie` を cache せず、SSE は buffer せずに stream します。provider と consumer の contract test は edge 経由でも実行します。

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
