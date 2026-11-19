## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-10-29T02:24:29Z
**Iteration:** 1
**Verdict Dictated:** no

### Review Scope

U2 の承認済み計画、設計成果物、code summary / traceability / source manifest、および manifest に列挙された application source と tests を差分レビューしました。共有境界は `contract-summary.md` と `unit-of-work.md` で照合しました。

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Critical | apps/beer-game/src/api/app.ts > `encodeActor` / `decodeActor`、`setSession` と apps/beer-game/src/application/game-service.ts > `authorizeFacilitator` | `bg_session` は署名も server-side lookup もない Base64 JSON で、認可処理は cookie 内の `kind` と `gameId` をそのまま信用しています。利用者が `FACILITATOR` を名乗る cookie を生成でき、任意 game の停止・終了・代理入力が可能です。 | session cookie を推測不能な opaque ID または改ざん検知付き cookie に置換し、server-side session から actor / membership を復元して、各 command で game・role membership を再検査する security test を追加してください。 | New |
| R-02 | Critical | apps/beer-game/src/application/game-service.ts > `GameService.games` / `creationKeys` と aidlc/spaces/default/intents/261027-beer-game-development/construction/u2-session-continuity/code-generation/code-summary.md > Remaining plan items | authoritative state、credential、idempotency、audit、event は依然として process-local `Map` にあり、追加 migration は runtime から一度も使用されません。process restart で全 session が消え、AC3.1.3、FR6.3、RPO 0、multi-instance 要件を満たせません。 | PostgreSQL-backed repository と transaction boundary を実装し、state・credential rotation・idempotency・audit・outbox を同一 transaction で保存してください。clean database migration、process restart、rollback、multi-instance recovery の integration tests を追加してください。 | New |
| R-03 | Major | apps/beer-game/src/api/app.ts > `/api/v1/sessions/:sessionId/*` routes | 全 session route が path の `sessionId` を parse / 照合せず、cookie の `gameId` だけで処理します。URI が示す resource と実際に更新・取得する session が一致せず、誤った session ID でも成功します。 | path parameter を command / query に渡し、actor membership と対象 session の一致を server 側で検証し、不一致を秘匿した 403 / 404 とする API tests を追加してください。 | New |
| R-04 | Major | apps/beer-game/src/application/game-service.ts > `emit` / `submitProxyDecision` / `recoverParticipation` と aidlc/spaces/default/intents/261027-beer-game-development/inception/contract-design/contract-summary.md > C3 Game Domain Events | 実装は `ProxyDecisionSubmitted` と `ParticipationRecovered` を発行しますが、C3 の eventType enum に存在しません。また durable outbox と session 単位の event sequence がなく、同じ aggregateVersion の event が複数発生して SSE ID が重複します。 | provider-owned C3 schema を正式に version updateし、eventSequence と payload を定義してください。その schema に従う transactional outbox、順序検査、重複排除、gap / replay tests を実装してください。 | New |
| R-05 | Major | aidlc/spaces/default/intents/261027-beer-game-development/construction/u2-session-continuity/code-generation/code-generation-plan.md > Implementation steps 3、7、8、10 と unit-test-instructions.md > Scope | 承認済み 11 steps のうち repository / DB integration、UI、restart / outbox / telemetry、Terraform / CI / docs が未完了で、予定 30〜40 tests に対して U2 tests は 7 件のみです。PostgreSQL integration、API security、E2E がなく、未実装 capability を unit-level in-memory tests だけで green としています。 | 未完了の plan steps を実装し、各 component 5〜8 tests、PostgreSQL integration、API authorization / recovery security、browser E2E、restart / outbox fault tests を追加してから summary と traceability を更新してください。 | New |
| R-06 | Major | apps/beer-game/src/security/credentials.ts > `credentialKey` と apps/beer-game/src/api/app.ts > rate-limit registration | HMAC key は未設定時に固定文字列へ fail-open し、recovery endpoint は global 120 requests/minute のみです。設計で定めた IP 10/minute、digest-prefix 5 failures/15 minutes、key version / rotation が実装されていません。 | production では secret 未設定時に起動を拒否し、key version を永続化して active / previous rotation を実装してください。recovery 専用の IP + transformed digest-prefix rate limit と failure audit tests を追加してください。 | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| `npm --prefix apps/beer-game exec vitest run tests/u2` | PASS: 1 file、7 tests | 現在の in-memory U2 behavior tests は green ですが、計画した integration / E2E volume を満たしません。 |
| `npm --prefix apps/beer-game run format:check` | PASS | formatting は正常です。 |
| `npm --prefix apps/beer-game run lint` | PASS | ESLint error はありません。 |
| `npm --prefix apps/beer-game run typecheck` | PASS | TypeScript type-check は成功しました。 |
| `npm --prefix apps/beer-game run test:coverage` | PASS: 59 tests、lines 95.97%、branches 84.29%、functions 100% | 設定対象 file の coverage floor は満たしますが、未実装の PostgreSQL / UI / outbox code は測定対象に存在しません。 |
| `npm --prefix apps/beer-game run e2e:u1` | PASS: 2 tests | U1 regression は green ですが、U2 E2E は存在しません。 |

### Summary

in-memory の機能 slice と既存 regression は通っていますが、session cookie の改ざんで facilitator 権限を取得でき、production persistence / restart recovery も未実装です。U2 の主要 plan と contract を完成させるまで production-ready ではありません。
