## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-05T00:58:58Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Critical | apps/beer-game/src/learning/learning-view.ts > `LearningViewService` state and `consume` | projection、processed event、cursor、export がすべて process-local `Map` / `Set` にあり、追加された PostgreSQL migration は実装から一度も利用されていません。したがって再起動で全 read model と冪等性情報が失われ、複数 ECS task 間でも状態が分裂し、projection と cursor の同一 transaction 保存という設計を満たしません。 | PostgreSQL repository / transaction adapter を実装し、event deduplication、projection、cursor を 1 transaction で永続化してください。export metadata も永続化し、再起動および複数 process での動作を integration test で確認してください。 | New |
| R-02 | Critical | apps/beer-game/src/api/app.ts > `decodeActor`、`learningActor`、Learning API routes | `bg_session` は署名も server-side lookup もない base64 JSON のため利用者が `kind: FACILITATOR` と任意の `gameId` を作れます。さらに U3 は query ごとの membership / role / session status 再検査をせず、`getExport` は `exportId` だけで全 game の export を検索します。この組合せにより observation、review、export の認可を回避できます。 | opaque credential を server-side actor context に解決し、U3 authorization port で各 request の membership、role、session status、path `gameId` を再検査してください。export lookup は game / actor / attempt / expiry で scope し、偽造 cookie と cross-game IDOR の test を追加してください。 | New |
| R-03 | Major | apps/beer-game/src/learning/learning-view.ts > `WeekRow`、`getReview`、`createExport` | 終了後 dataset は週、在庫、受注残、注文だけで、需要、役割別系列、出荷、週次費用、累積費用、ゲーム設定、意思決定、操作履歴を持ちません。それでも export を即時 `COMPLETE` として公開するため、FR7.1 / FR7.2 と BR12.2 / BR13.1 の完全性判定が成立しません。 | canonical review dataset を要求された全系列と metadata を含む形に拡張し、共通週軸の連続性と両形式の数量・費用一致を検査してからのみ COMPLETE にしてください。欠損時は NO_DATA / PROJECTION_FAILED / FAILED を区別してください。 | New |
| R-04 | Major | apps/beer-game/tests/u3/learning-view.integration.test.ts > `C3 boundary validation` | integration test は in-memory service を直接呼ぶ 2 件だけで、PostgreSQL transaction、Fastify C6 routes、fresh authorization、idempotency、gap rebuild、partial export cleanup を検証していません。`code-summary.md` の「PostgreSQL/HTTP integration」と「未実行 test はありません」という主張を裏付けません。 | real PostgreSQL adapter と Fastify inject を使う C3/C6 integration test を追加し、transaction rollback、restart recovery、authorization matrix、IDOR、rebuild、partial failure を実行してください。 | New |
| R-05 | Major | apps/beer-game/src/learning/learning-view.ts > `eventSchema` と disclosure policy | C3 の `eventType` は任意文字列、`occurredAt` と `correlationId` は空文字も通り、未知 event を正規 event として projection に適用します。また逆算防止は contributor count だけで、公開値の連立から個別値を解ける場合を検出しません。 | C3 contract の event enum、date-time、non-empty correlation ID を検証し、未知 major / invalid event を隔離してください。公開 aggregate 間の依存関係を評価する disclosure policy と property test を実装してください。 | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| `npm --prefix apps/beer-game test -- --run tests/u3` | PASS: 2 files、10 tests | 現在の in-memory unit test は成功しましたが、永続化・HTTP・認可境界を通らないため上記の production failure を検出できません。 |

### Summary

局所的なシナリオは green ですが、実装は設計済みの永続化と認可境界を接続しておらず、再起動・複数 task・悪意ある client の条件で破綻します。終了後 dataset も要求された分析と export の完全性を満たしていないため、現状はリリース可能な U3 実装ではありません。
