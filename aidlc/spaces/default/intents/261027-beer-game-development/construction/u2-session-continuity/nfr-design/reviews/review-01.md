## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-10-29T01:46:02Z
**Iteration:** 1
**Verdict Dictated:** no

### Review Scope

U2 Session Continuity の NFR requirements、functional specification、C2 / C3 shared contracts、および performance、security、scalability、reliability、observability、logical components、traceability の設計成果物を確認しました。他 Unit の Construction 成果物は参照していません。

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261027-beer-game-development/construction/u2-session-continuity/nfr-design/scalability-design.md > Event distribution | 複数 dispatcher が `FOR UPDATE SKIP LOCKED` で任意の outbox row を並行 claim するだけでは、同一 session の連続 event が別 worker から逆順に配信され得ます。`aggregateVersion` の gap 検出と snapshot fallback は破損検知・回復であり、NFR12.3 が要求する instance 間の配信順序保証そのものではありません。 | session ごとの partition key、advisory lock、head-of-line claim 条件など、同一 session を直列化する仕組みを定義し、先行 event の未配信中に後続 event が配信されない multi-dispatcher test を追加してください。順序保証をしないなら NFR12.3 と設計上の claim をその実態に合わせて変更してください。 | New |
| R-02 | Major | aidlc/spaces/default/intents/261027-beer-game-development/construction/u2-session-continuity/nfr-design/logical-components.md > Contract boundaries | Functional Specification は `ProxyDecisionSubmitted` を必ず発行するとしていますが、共有 C3 contract の `eventType` enum にこの event はありません。設計は「追加する場合」に contract を更新するとだけ記し、実装が依存する event 名、payload、version compatibility、owner の確定を先送りしています。現状のままでは producer と consumer が同じ schema に基づいて実装できません。 | 実装前の条件ではなく、この Unit が使う正式な C3 event として event type、payload required fields、schema version、compatibility test owner を contract source-of-truth に確定するか、既存 `DecisionSubmitted` を使う設計へ統一してください。 | New |
| R-03 | Major | aidlc/spaces/default/intents/261027-beer-game-development/construction/u2-session-continuity/nfr-design/observability-design.md > Alerts | NFR14.3 は restart recovery failure を 1 minute 以内に alert する要求ですが、設計は readiness failure を 5 minutes 待ってから critical としています。synthetic check も実行間隔がないため、2 回連続失敗が 1 minute 以内に判定できる保証がありません。traceability.json はこの矛盾がある状態で NFR14.3 を `OK` としています。 | restart recovery 用に 1 minute 以内で確実に成立する evaluation window、synthetic check interval、連続回数、通知遅延 budget を定義し、traceability target をその具体的な rule に結び付けてください。 | New |
| R-04 | Major | aidlc/spaces/default/intents/261027-beer-game-development/construction/u2-session-continuity/nfr-design/reliability-design.md > Health and recovery objectives | committed data の RPO 0 を宣言していますが、durability topology は「Infrastructure Design で具体化」に留まり、single PostgreSQL failure、AZ loss、backup restore のどの範囲で RPO 0 を保証するかが未定義です。単一 transaction は原子性を提供しますが、storage failure に対する RPO 0 の根拠にはなりません。 | RPO 0 の failure scope を明記し、その scope に必要な synchronous replication、commit acknowledgement 条件、failover 時の data-loss check を設計してください。災害時 RPO 0 を保証しないなら、別の measurable RPO と対象障害を要件側で確定してください。 | New |
| R-05 | Major | aidlc/spaces/default/intents/261027-beer-game-development/construction/u2-session-continuity/nfr-design/reliability-design.md > Transaction boundary | U2 は C2 の `appendSessionTransition` だけを使うとしていますが、C2 の operation は lifecycle `transition` の append しか定義しておらず、proxy decision の quantity、reason、target role と recovery credential rotation を同じ transaction に含める contract shape がありません。設計が要求する GameSession、credential、idempotency、audit、outbox の原子的更新を U1 owner boundary 越しに実装する方法が確定していません。 | C2 に proxy decision と credential rotation を含む owner-controlled transaction command を追加し、input、output、errors、transaction participants を定義するか、U1 / U2 の ownership と transaction boundary を変更してください。 | New |
| R-06 | Minor | aidlc/spaces/default/intents/261027-beer-game-development/construction/u2-session-continuity/nfr-design/security-design.md > Authentication and credential lifecycle | HMAC key version を保存し active + previous key を読む設計ですが、previous key を廃止できる条件、token expiry との overlap、key compromise 時の全 token 失効方法がありません。raw token を保持しないため既存 digest を新 key へ再計算できず、rotation 手順を誤ると有効 token が一斉に復帰不能になります。 | key version ごとの最長 token expiry、previous key 保持期間、compromise 時の失効・再発行手順、rotation 中の検証 test を定義してください。 | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| JSON parse | PASS | `traceability.json` は有効な JSON です。 |
| NFR ID coverage check | PASS: 22 requirement IDs covered exactly once | NFR10.1〜NFR14.4 の列挙は完全ですが、`OK` の内容妥当性には上記 NFR12.3、NFR13.1、NFR14.3 の問題があります。 |
| Contract reference search | FAIL: C3 enum に `ProxyDecisionSubmitted` が存在しない | Functional Specification と shared event contract の不一致を確認しました。 |

### Summary

設計は stateless application、PostgreSQL authority、transactional outbox、credential redaction の方向性を明確にしています。一方で、event ordering、C2 / C3 contract、restart alert、RPO 0 の保証境界に実装を止める不整合が残っているため、現時点では NOT-READY です。
