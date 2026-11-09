# Security Design - U4 Retention Operations

## Trust boundaries and authorization

- operator API は既存 actor context を受けても毎 request で operator role と game scope を server-side 検査します。
- scheduler、outbox dispatcher、owner worker は個別 IAM role と least-privilege policy を使用します。
- U4 は owner table に接続せず、C4 / C5 の published contract だけを使用します。

## Contract validation and replay defense

- C4 / C5 は schema allowlist、UUID、owner enum、timestamp、failure code を境界で検証します。
- C5 に必須の `attempt`（integer、minimum 1）を追加します。`deletionId + ownerUnit + attempt` が current progress と一致する場合だけ遷移し、旧 attempt は監査記録後に無視します。
- `eventId` は一意制約で deduplicate し、同一 key の異なる payload は security event として隔離します。
- unknown major schema は DLQ に隔離し、状態を更新しません。

## Data protection

- TLS 1.2 以上を通信に使用し、PostgreSQL、SQS、DLQ、log storage は KMS customer-managed key で暗号化します。
- receipt の game reference は keyed HMAC-SHA-256 とし、key は Secrets Manager で rotation します。生の game ID、displayName、token、credential digest、削除 payload は保持しません。
- receipt は作成から 1 年後に cleanup worker が削除し、削除結果自体も audit metric に限定します。
- log/trace exporter に field allowlist と redaction test を適用します。

## Web controls

operator API は input schema validation、CSRF 対策済み same-site session、secure headers、rate limit、RFC 9457 error response を使用し、resource existence の漏えいを避けます。

## Verification

authorization matrix、IDOR、replay、stale attempt、schema fuzz、PII scan、KMS/IAM policy test、1 年 lifecycle test を CI と staging で実行します。

## Sources

- `nfr-requirements/security-requirements.md`
- `contract-summary.md` C4 / C5
- `nfr-design-questions.md` Q1

## Assumptions & Open Questions

- C5 schema の `attempt` 追加は required field のため major contract change として扱い、consumer fixture を同時更新します。
