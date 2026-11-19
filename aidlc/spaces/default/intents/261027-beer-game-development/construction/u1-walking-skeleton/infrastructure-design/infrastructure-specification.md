# Infrastructure Specification - u1-walking-skeleton

## Deployment

| Facet | Choice | Rationale |
|---|---|---|
| Region | `ap-northeast-1` | 日本の利用者への latency と service availability |
| Compute | ECS Fargate service: API/SSE、outbox worker | stateless horizontal scaling と container isolation |
| Frontend | private S3 origin + CloudFront + WAF | global TLS delivery、origin 非公開、security headers |
| Ingress | Route 53 → CloudFront / ALB、ACM TLS | managed DNS、HTTPS only、health-based routing |
| Network | 2 AZ VPC、public ALB、private ECS / RDS subnet、least-privilege security group | Multi-AZ failure isolation と database 非公開化 |
| Storage | RDS PostgreSQL Multi-AZ synchronous standby、PITR、encrypted storage | committed week の RPO 0 / RTO 15 minutes target |
| Secrets | Secrets Manager + rotation、SSM Parameter Store for non-secret config | runtime injection、no secret in image / Terraform state output |
| Environments | dev / staging / production separate state and account or strict boundary | topology parity、blast-radius isolation |
| IaC | Terraform、remote encrypted state + locking、plan review | reproducible provisioning と drift control |
| Sizing | initial API 2 tasks across AZs、worker 1 active task、RDS small Multi-AZ; load-test driven | 75 active users の可用性と cost balance |

## Infrastructure Services

| Service | Role | Configuration | Notes |
|---|---|---|---|
| ECS Fargate | compute | API/SSE min 2 tasks、worker independent task definition | rolling staging、blue-green production |
| ALB | load balancer | HTTPS、health checks、idle timeout suitable for SSE | sticky session 不要 |
| RDS PostgreSQL | database | Multi-AZ、encrypted、PITR、performance insights | authoritative state / outbox / idempotency |
| S3 + CloudFront | static web / CDN | OAC、versioned immutable assets、WAF | SPA fallback constrained to frontend routes |
| ECR | artifact registry | immutable digest、scan on push、lifecycle policy | deployed image pinned by digest |
| Secrets Manager | secrets | DB credential / signing secret rotation | task role read-only access |
| CloudWatch / X-Ray-compatible OTEL | metrics/logs/traces | structured redacted logs、alarms、dashboards | vendor-neutral instrumentation |
| KMS | encryption | separate key policy for data, logs, secrets | least privilege and rotation |

## Shared Infrastructure

| Shared Resource | Owner Unit | Consumer Units | Access Boundary |
|---|---|---|---|
| VPC / ALB / ECS cluster | U1 | U2-U5 application modules | deployment role and security groups |
| RDS PostgreSQL | U1 platform boundary | U1-U4 owner schemas/modules | owner application interface; no cross-owner table write |
| CloudFront / S3 web | U1 initially | U5 refined UI | CI deployment role only |
| Telemetry platform | U1 platform boundary | all Units | redaction policy and scoped write identity |

## Cost and Operations

Budget alarm、mandatory tags (`project`, `environment`, `owner`, `cost-center`) を設定します。dev は scheduled scale-down、production は Multi-AZ を維持します。NAT cost は VPC endpoints for ECR/S3/CloudWatch/Secrets Manager と比較して選定します。

## Sources

U1 `nfr-design/` 全成果物、`functional-spec.md`、`components.md`、`contract-summary.md`、`infrastructure-design-questions.md`。

## Assumptions & Open Questions

AWS account IDs、domain、budget threshold、exact task / RDS size は Environment Provisioning 前に確定します。
