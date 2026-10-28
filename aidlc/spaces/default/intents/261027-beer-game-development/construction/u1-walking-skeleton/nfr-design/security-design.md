# Security Design - u1-walking-skeleton

## Authentication

- facilitator / participant credential は 128-bit 以上の CSPRNG token とし、server-side digest だけを保存します。
- browser には `HttpOnly; Secure; SameSite=Strict` cookie で保持し、game / role scoped opaque session ID として送信します。
- state-changing request は origin check と CSRF token を要求し、join code は authentication に使いません。
- game 終了 24 hours 後、explicit revoke、deletion のいずれか早い時点で cookie session と digest を無効化します。

## Authorization and Data Protection

- Fastify pre-handler が credential を解決し、application command/query が game、session、role、operation を再検査します。
- role-safe DTO を専用 serializer で生成し、domain object を直接 response / SSE payload に渡しません。
- TLS 1.2+、managed database encryption at rest、runtime secret store、CSP、HSTS、`nosniff`、frame denial を適用します。
- structured log redaction allowlist により token、digest、display name、role-private state を出力しません。

## Threat Controls

Object-level authorization matrix、replay / idempotency、stale version、XSS / CSRF、credential rotation、cross-game access を automated security test にします。SAST、dependency scan、secret scan の High / Critical は release を阻止します。

## Sources

`security-requirements.md`、`reliability-requirements.md`、`functional-spec.md`、`contract-summary.md`、`nfr-design-questions.md`。

## Assumptions & Open Questions

Cookie 名と CSRF library は Code Generation plan で確定します。
