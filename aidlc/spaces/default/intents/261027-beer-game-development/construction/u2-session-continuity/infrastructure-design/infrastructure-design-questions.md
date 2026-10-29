# Infrastructure Design Questions - U2

## Decisions

- Q1 compute: ECS Fargate containers behind an ALB. [Answer]: Adopt
- Q2 data: Amazon RDS for PostgreSQL Multi-AZ as the sole authority. [Answer]: Adopt
- Q3 events: PostgreSQL transactional outbox; no new broker for U2. [Answer]: Adopt
- Q4 delivery: `develop` validates and deploys dev, `main` deploys staging, production requires manual approval. [Answer]: Adopt
- Q5 IaC: existing Terraform layout under `apps/beer-game/infra` is extended. [Answer]: Adopt

## Assumptions & Open Questions

- AWS region and account IDs remain environment configuration, not source constants.
- Production starts at two Fargate tasks; dev may use one task while retaining the same topology.

