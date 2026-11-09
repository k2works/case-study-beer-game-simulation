# CI/CD Pipeline - u5-accessible-experience

## Stages and gates

| Stage | Gate | Evidence |
|---|---|---|
| Build | React / TypeScript asset と API image を commit SHA に結び付けて生成。immutable asset 名と manifest を出す | artifact digest、SBOM、provenance |
| Static checks | Prettier、ESLint、typecheck、dependency / secret scan を pass | CI result |
| BDD and integration | U5 の Given/When/Then、role authorization、version conflict、cookie / Origin negative case、SSE / polling を pass。line coverage 80% 以上 | Vitest / Playwright / coverage report |
| Accessibility automation | Chrome / Edge / Firefox / Safari 相当 engine の keyboard、semantic、contrast、200% zoom、chart / table 同値性を確認 | browser matrix と E2E artifact |
| Accessibility manual | Windows NVDA + Chrome、macOS VoiceOver + Safari の主要 flow と、4 browser 最新 2 世代の keyboard 操作を確認 | OS / browser / screen reader version と結果 |
| Staging deploy | `main` merge 後、既存 ECS rolling と versioned CloudFront asset を自動配信。API / SSE と UI の互換性 smoke を実行 | deployment digest、SSE 75 接続と fallback test |
| Production approval | staging の性能、アクセシビリティ、認証、shared contract 証跡を確認し、手動承認 | release evidence と rollback 対象 |
| Production deploy | API blue-green と CloudFront version switch を同一 release manifest で調整 | synthetic SLI と alarm の bake window |

## Promotion and rollback

`develop` で統合し、release 時に `main` へ merge します。staging は `main` で自動反映し、production は手動承認後に同じ digest を promote します。API / SSE と UI は互換 window を持ち、古い UI が新 API に接続しても失敗を安全に表示します。異常時は CloudFront の manifest / asset prefix と ECS の既知良好 digest を戻し、cache された旧 asset が一定期間残ることを smoke test で確認します。

## Secrets and contract gate

GitHub Actions は OIDC で環境別 deploy role を引き受け、長期 AWS key を置きません。runtime secret は Secrets Manager を使用し、cookie signing key、DB credential、token を CI log / artifact / frontend bundle に含めません。

U1〜U4 の browser 向け API、SSE、export、保持状態 / retry と CSRF 方針が共有契約に確定していない間は、U5 の integration / staging gate を pass としません。受入試験は確定した provider 契約の request、response、認可、version、失敗形を参照します。

## Sources

- `construction/u5-accessible-experience/nfr-design/performance-design.md`
- `construction/u5-accessible-experience/nfr-design/security-design.md`
- `construction/u5-accessible-experience/nfr-design/logical-components.md`
- `construction/u5-accessible-experience/functional-design/functional-spec.md`
- `inception/domain-design/components.md`
- `inception/contract-design/contract-summary.md`
- `construction/u1-walking-skeleton/infrastructure-design/cicd-pipeline.md`

## Assumptions & Open Questions

- Safari 本体と screen reader の手動確認は macOS / Windows の実環境を必要とします。実施者、環境、version の証跡を release に添付します。
