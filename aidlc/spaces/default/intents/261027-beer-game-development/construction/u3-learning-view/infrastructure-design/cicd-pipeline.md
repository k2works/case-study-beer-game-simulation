# CI/CD Pipeline - U3 Learning View

## Pull request checks

1. Format, ESLint, TypeScript compile.
2. Vitest BDD/unit/integration tests and ≥80% line coverage.
3. C3/C6 schema lint and provider/consumer contract fixtures.
4. Playwright browser/accessibility/compatibility smoke tests.
5. Dependency, secret, SAST, container, and IaC scans; High/Critical blocks merge.
6. IaC synth/validate, policy assertions for encryption, private access, backups, least privilege, and drift preview.

## Delivery

`develop` builds a commit-SHA immutable image and deploys the staging topology, then runs migrations, smoke/E2E, projection replay, and export fault tests. `main` automatically updates staging per team policy. Production promotion reuses the tested image, requires manual approval, uses backward-compatible migrations and rolling deployment, then runs smoke and SLO checks. Automated rollback restores the prior task definition; database migrations use expand/contract and are never destructively rolled back.

## Supply chain

Images are signed, SBOM is stored, base digests are pinned, and provenance is retained. Pipeline credentials use OIDC roles rather than long-lived keys.

## Sources

- U3 `tech-stack-decisions.md`
- Project deployment and testing rules
