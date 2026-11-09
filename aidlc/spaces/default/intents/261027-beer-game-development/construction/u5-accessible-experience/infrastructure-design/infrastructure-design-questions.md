# U5 Infrastructure Design 質問

追加の判断はありません。U1 で選択済みの ECS Fargate + ALB、S3 + CloudFront、dev / staging / production、GitHub Actions と、U5 で選択済みの SameSite=Strict + Origin 検査、NVDA + Chrome / VoiceOver + Safari の受入条件を継承します。

## Sources

- `construction/u1-walking-skeleton/infrastructure-design/infrastructure-design-questions.md`
- `construction/u5-accessible-experience/nfr-design/nfr-design-questions.md`
- `construction/u5-accessible-experience/nfr-requirements/nfr-requirements-questions.md`

## Assumptions & Open Questions

- 共有 browser 契約と CSRF 方針の統一は provider 合意待ちです。インフラの新しい選択肢は発生していません。
