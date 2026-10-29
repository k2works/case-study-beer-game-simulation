# Infrastructure Specification - U3 Learning View

## Topology

U3 shares the existing ECS/Fargate application service and PostgreSQL database of the modular monolith. Production spans two Availability Zones behind an ALB. Private subnets contain tasks and RDS; only the ALB is public. U3 adds PostgreSQL projection/cursor/export metadata tables, an encrypted SQS standard queue with DLQ for projection/export work, and a private S3 bucket for completed export artifacts.

## Resources

| Resource | Design |
|---|---|
| ECS service | Non-root read-only container, two production tasks, rolling deployment, 512 CPU/1 GiB initial limit, autoscale 2–6. |
| RDS PostgreSQL | Multi-AZ production, encrypted KMS storage, PITR 7 days, private security group, connection pool capped per task. |
| SQS | KMS encryption, 60-second visibility, redrive after 5 receives, sessionId message-group abstraction in the consumer layer. |
| S3 exports | Block all public access, SSE-KMS, versioning, incomplete multipart cleanup after 1 day, lifecycle deletion at game retention deadline. |
| Secrets | Secrets Manager for database credentials with rotation; no secret in image or plain environment configuration. |

## IAM and network

Task role grants only queue consume/send, scoped export-prefix object access, KMS use, secret read, and telemetry write. Security groups allow ALB→ECS and ECS→RDS only. VPC endpoints are preferred for S3, SQS, Secrets Manager, and telemetry to reduce public egress.

## Environments and cost

The same Terraform/CDK-compatible topology is parameterized for local, staging, and production; staging uses one task and single-AZ database, production uses Multi-AZ. Budget alarms fire at 50/80/100%. Initial design avoids Redis and a separate service to reduce cost and operations.

## Sources

- U3 `logical-components.md`, `security-design.md`, `reliability-design.md`
