# Infrastructure Design Questions - u1-walking-skeleton

## Q1 AWS deployment model

application をどの AWS compute model へ配置しますか？

- A. ECS Fargate + ALB、React は S3 + CloudFront
- B. AWS App Runner、React は S3 + CloudFront
- C. EKS、React は S3 + CloudFront
- X. Other (please specify)

[Answer]: A. ECS Fargate + ALB、React は S3 + CloudFront

## Q2 Infrastructure as Code

AWS resource の IaC をどれで管理しますか？

- A. Terraform
- B. AWS CDK with TypeScript
- C. CloudFormation
- X. Other (please specify)

[Answer]: A. Terraform

## Q3 Deployment strategy

staging / production の application deployment strategy をどうしますか？

- A. Staging rolling、production blue-green with manual approval
- B. Rolling update in all environments
- C. Canary in staging and production
- X. Other (please specify)

[Answer]: A. Staging rolling、production blue-green with manual approval

## Q4 Primary region

primary AWS Region はどこにしますか？

- A. ap-northeast-1 (Tokyo)
- B. ap-northeast-3 (Osaka)
- C. Another Region
- X. Other (please specify)

[Answer]: A. ap-northeast-1 (Tokyo)

## Sources

- `construction/u1-walking-skeleton/nfr-design/`
- `construction/u1-walking-skeleton/functional-design/functional-spec.md`
- `inception/domain-design/components.md`
- `inception/contract-design/contract-summary.md`

## Assumptions & Open Questions

- None.
