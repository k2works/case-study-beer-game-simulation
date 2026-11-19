# Tech Stack Decisions - U4 Retention Operations

## Decisions

| Concern | Selection | Rationale |
|---|---|---|
| Runtime | 既存 TypeScript / Fastify module | modular monolith と既存認可規約を再利用する |
| Durable state | 既存 PostgreSQL | Saga、owner progress、receipt、outbox の transaction を保持する |
| Async delivery | AWS SQS standard + DLQ | at-least-once delivery、backoff、owner worker scaling に適合する |
| Scheduling | EventBridge schedule + idempotent scheduler | 期限走査を application request から分離する |
| Infrastructure | 既存 Terraform | project の IaC と CI checks に統合する |
| Telemetry | OpenTelemetry-compatible structured signals | correlation ID と metrics/log/trace を横断する |

## Constraints

owner table を U4 から直接削除せず、C4/C5 contract を使用します。secret は Secrets Manager、暗号化 key は KMS を使用し、品質 target を下げる構成変更は禁止します。

## Sources

- `technology-stack.md`
- `contract-summary.md` C4/C5
- `requirements.md` NFR8、NFR9
