# CI/CD Pipeline - U2 Session Continuity

## Pipeline stages

| Stage | Actions | Gate |
|---|---|---|
| Validate | npm clean install、format check、ESLint、type-check | all checks pass |
| BDD / test | Given/When/Then tests、unit、PostgreSQL integration、contract tests | all tests pass、line coverage ≥80% |
| Security | dependency audit、secret scan、container scan、Terraform fmt / validate / tflint / checkov | Critical / High unresolved findings = fail |
| Build | reproducible container build、SBOM、ECR push by digest | signed artifact and immutable digest |
| Infrastructure plan | Terraform plan per environment | reviewed plan、no destructive production change without approval |
| Dev deploy | `develop` branch rolling deploy | smoke + recovery synthetic pass |
| Staging deploy | `main` merge rolling deploy | migration precheck、smoke、k6 baseline、alarm health |
| Production deploy | promote same image digest | manual approval after staging evidence |

## Deployment and rollback

ECS deployment circuit breaker と CloudWatch alarm rollback を有効化します。database migration は expand / migrate / contract の後方互換順で実行し、application rollback 中も旧 version が読める状態を保ちます。失敗時は直前の ECR digest と task definition revision へ戻し、schema contract は別 release window で除去します。

## Secrets and identity

GitHub Actions は AWS OIDC role を assume し、long-lived AWS key を保存しません。environment role は dev / staging / production で分離し、production role は protected environment approval 後のみ利用できます。runtime secrets は Secrets Manager reference とし、CI log へ materialize しません。

## Required U2 verification

- 2 instances で sticky-session 非依存の recovery と SSE reconciliation を実行します。
- process kill、transaction rollback、outbox replay、rotation race、stale version を PostgreSQL integration tests で検査します。
- log redaction、metric / trace propagation、restart 1-minute alert を staging synthetic test で確認します。
- C2 / C3 provider-consumer compatibility tests を merge 前に実行し、`ProxyDecisionSubmitted` を contract source-of-truth へ追加してから code を deploy します。

