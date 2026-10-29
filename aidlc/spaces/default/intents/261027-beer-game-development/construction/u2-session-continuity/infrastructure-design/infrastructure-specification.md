# Infrastructure Specification - U2 Session Continuity

## Deployment

| Facet | Choice | Rationale |
|---|---|---|
| Compute model | ECS Fargate service, minimum 2 tasks in staging / production | Containerized Fastify applicationを stateless に水平拡張するためです。 |
| Networking topology | 2 AZ VPC、public ALB、private application subnets、isolated database subnets | internet ingress を ALB に限定し、database を非公開にします。 |
| Storage strategy | RDS for PostgreSQL Multi-AZ、encrypted storage、PITR | state、credential digest、audit、idempotency、outbox の単一 authority と RPO 0 transaction を支えます。 |
| Environments | dev / staging / production を同一 Terraform module で parameterize | topology parity を保ち、scale と retention だけを変えます。 |
| IaC approach | existing `apps/beer-game/infra` Terraform を network / data / compute / monitoring modules に拡張 | U1 の資産と運用方法を継続します。 |
| Resource sizing | Fargate 0.5 vCPU / 1 GiB から開始、RDS db.t4g.small dev、db.t4g.medium staging / production | 25 games / 100 SSE baseline を満たし、計測に基づき right-size します。 |
| Scaling | tasks 2〜6、CPU 60% または event-loop lag p95 100 ms、scale-in 15 min | connection drain と database pool budget を守ります。 |

## Infrastructure Services

| Service | Role | Configuration | Notes |
|---|---|---|---|
| Application Load Balancer | load-balancer | TLS、idle timeout 120 s、SSE path health check | HTTP→HTTPS redirect、AWS WAF rate rule を適用します。 |
| ECS Fargate | compute | multi-AZ、rolling minimum healthy 100%、deployment circuit breaker | graceful shutdown で SSE connection を drain します。 |
| RDS PostgreSQL | database | Multi-AZ、encrypted、automated backup 14 days、PITR、TLS required | connection 上限の 70% を task pools の総予算とします。 |
| Secrets Manager | secrets | HMAC / cookie keys、RDS credential、rotation metadata | task role の resource-scoped read のみ許可します。 |
| CloudWatch Logs | logs | JSON logs、30 days staging、90 days production | token / digest / cookie を subscription filter test で排除します。 |
| CloudWatch Metrics / Alarms | monitoring | EMF custom metrics、1-minute periods | latency、recovery、outbox、invariant を監視します。 |
| ECR | artifact registry | immutable tags、scan on push、lifecycle 30 images | digest pinning で deploy します。 |
| Route 53 / ACM | dns | environment subdomain、managed TLS certificate | certificate renewal を自動化します。 |

## Shared Infrastructure

| Shared Resource | Owner Unit | Consumer Units | Access Boundary |
|---|---|---|---|
| ECS service / ALB | U1 | U2、U3 | modular monolith process boundary、public routes は contract tests で保護 |
| RDS PostgreSQL cluster | U1 | U2、U3、U4 | schema ownership、least-privilege migration role、application interface C2 |
| Transactional outbox | U1 GameSession | U2 producer、U3 consumer | owner migration + versioned C3 schema |
| CloudWatch telemetry | U1 platform | U2〜U5 | namespace と log allowlist を共有し、dashboard は Unit dimension で分離 |

## Security and recovery

Security groups は ALB→ECS application port、ECS→RDS 5432 のみを許可します。task は private subnet で public IP を持ちません。KMS-backed encryption、Secrets Manager、least-privilege task / execution roles、CloudTrail を使用します。RDS restore drill を四半期ごとに行い、15 minutes の application recovery objective を staging で検証します。

