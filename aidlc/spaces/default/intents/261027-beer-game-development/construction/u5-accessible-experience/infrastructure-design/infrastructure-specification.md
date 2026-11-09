# Infrastructure Specification - u5-accessible-experience

## Deployment

| Facet | Choice | Rationale |
|---|---|---|
| Compute model | 既存 ECS Fargate の Fastify API / SSE service を共用し、U5 は React の静的資産として配信 | U5 に独立した server を増やさず、既存の認可・version 契約へ接続する。 |
| Networking topology | 単一の browser origin を CloudFront に置き、静的 route は private S3、`/api/*` と `/events/*` は ALB / ECS へ転送。API と SSE は cache 無効、cookie と Origin header を必要な範囲で転送 | SameSite=Strict と Origin 検査を browser flow 全体で成立させ、cross-origin credential request を避ける。 |
| SSE transport | CloudFront / ALB の idle timeout は server heartbeat 間隔より長く設定し、streaming response を buffering / cache せずに転送 | 75 接続の長寿命 stream と 2 秒反映を維持する。 |
| Storage strategy | 静的資産は private S3 の versioned prefix と immutable hash 名を使用。業務状態は既存 PostgreSQL、export は既存 U3 object store が所有 | UI に個人情報や token の永続保存を増やさない。 |
| Environments | dev / staging / production で同じ path routing と security header を使い、production は既存 2 AZ / 2 task の最小構成を継承 | browser 認証と SSE の環境差を減らす。 |
| IaC approach | 既存 Terraform module を変更し、CloudFront behavior、ALB route、header policy、SSE timeout を version 管理 | 手動設定差分を残さない。 |
| Resource sizing | 基準は 15 game × 5 user = 75 SSE 接続。全 fallback 時の 75 snapshot request/秒を API capacity 試験に加える | NFR1.11 / NFR1.12 の受入負荷を満たすため。 |

## Infrastructure Services

| Service | Role | Configuration | Notes |
|---|---|---|---|
| S3 + CloudFront | CDN / static web | private origin、OAC、versioned asset prefix、API / SSE behavior は cache disabled | U5 UI 配信。SPA fallback を API / SSE には適用しない。 |
| AWS WAF | edge protection | 既存 rule と request rate control、credential 値の log masking | 認証・参加 endpoint の濫用を抑える。 |
| ALB + ECS Fargate | load balancer / compute | min 2 API task、SSE health check と draining、75 接続 + fallback 負荷で scale 試験 | sticky session に依存しない。 |
| RDS PostgreSQL | database | 既存 U1〜U4 の authoritative state を維持 | U5 から直接接続しない。 |
| CloudWatch + OpenTelemetry | monitoring | browser span と server correlation ID、SSE lag、fallback rate を低 cardinality で集約 | token、表示名、参加コードを記録しない。 |
| Route 53 + ACM | DNS / TLS | 単一の公開 browser host、HTTPS only | Strict cookie と Origin 検査の境界。 |

## Shared Infrastructure

| Shared Resource | Owner Unit | Consumer Units | Access Boundary |
|---|---|---|---|
| CloudFront / S3 web | U1 platform baseline | U5 | CI deploy role のみ write。browser は静的 read。 |
| ALB / ECS / VPC | U1 platform baseline | U2〜U5 | U5 は HTTPS 経由のみ。API / SSE route は provider owner が定義。 |
| RDS PostgreSQL | U1 platform baseline | U1〜U4 | U5 の直接 database access を禁止。 |
| Export object store | U3 | U5 | U3 の認可付き download API / URL を通す。 |

## Sources

- `construction/u5-accessible-experience/nfr-design/performance-design.md`
- `construction/u5-accessible-experience/nfr-design/security-design.md`
- `construction/u5-accessible-experience/nfr-design/logical-components.md`
- `construction/u5-accessible-experience/functional-design/functional-spec.md`
- `inception/domain-design/components.md`
- `inception/contract-design/contract-summary.md`
- `construction/u1-walking-skeleton/infrastructure-design/infrastructure-specification.md`

## Assumptions & Open Questions

- CloudFront の API / SSE 同一 origin routing は U1 baseline の追加設定であり、共有契約と deploy plan の更新が必要です。SSE URL と event schema は未確定です。
