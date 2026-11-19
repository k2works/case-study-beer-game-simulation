# CI/CD Pipeline - u1-walking-skeleton

## Pipeline Stages

| Stage | Actions | Gate / Evidence |
|---|---|---|
| Validate | format、lint、type-check、Terraform fmt/validate、TFLint、Checkov | any failure blocks |
| BDD / Test | Vitest unit + integration、Playwright E2E / accessibility、coverage | 80% line floor、required scenarios green |
| Security | dependency / secret / container / IaC scan | High / Critical blocks release |
| Build | reproducible frontend asset + OCI image | immutable digest、SBOM、provenance |
| Terraform Plan | environment-scoped plan | reviewed plan artifact; no secret output |
| Staging Deploy | Terraform apply、ECS rolling、frontend version publish | automatic on `main`; smoke + integration + rollback check |
| Production Approval | release evidence、change summary、staging result | manual approval required |
| Production Deploy | ECS blue-green、CloudFront version switch | health / SLO bake window before traffic completion |

## Rollback

Application は previous ECR digest と previous frontend version へ traffic を戻します。database migration は expand/contract と backward-compatible application window を必須とし、destructive rollback を前提にしません。Terraform state versioning と reviewed reverse plan を保持します。

## Identity and Secrets

GitHub Actions OIDC から environment-specific least-privilege deploy role を assume し、long-lived AWS key を保存しません。runtime secret は Secrets Manager から ECS task role が取得し、CI log / artifact / Terraform output に出しません。

## Branch and Promotion

feature work は `develop` へ統合し、release 時に `main` へ merge します。`main` は staging へ自動反映し、production は manual approval 後に同じ digest を promote します。

## Sources

`infrastructure-specification.md`、`monitoring-design.md`、U1 NFR design、team practices、`infrastructure-design-questions.md`。

## Assumptions & Open Questions

CI provider は既存 GitHub Actions を継続する前提です。
