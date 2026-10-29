# Security Requirements - U3 Learning View

## Requirements

| ID | Requirement | Verification |
|---|---|---|
| NFR3.1 | Every C6 request revalidates server-side game membership, role, and session status; client claims are never authoritative. | Forged, expired, cross-game, and revoked credential tests. |
| NFR3.2 | Responses use field allow-lists and exclude role-private values, future demand, credentials, tokens, and existence details from responses, logs, traces, caches, and errors. | Schema and sensitive-data scans. |
| NFR3.3 | Team totals are fail-closed suppressed for fewer than two independent contributors or any inverse-disclosure path. | Property tests over public-value combinations. |
| NFR3.4 | Review requires `ENDED`; export create/status/download is facilitator-only and reauthorized each time. Opaque download references expire in 15 minutes. | Authorization matrix tests. |
| NFR3.5 | TLS 1.2+ is required outside localhost; HSTS, CSP, `nosniff`, and restrictive referrer policy are set. | Deployment security checks. |
| NFR4.1 | U3 stores no recovery token and no personal data beyond stable internal authorization/audit identifiers. | Schema inspection. |
| NFR4.2 | Export packages inherit the game retention deadline and are unavailable during deletion. | C4/C5 deletion tests. |

Threat controls include IDOR-safe authorization, C3 schema/source validation, CSV formula-injection escaping, and export rate limiting at 5 requests per facilitator/game/10 minutes.

## Sources

- `requirements.md` NFR3, NFR4
- `contract-summary.md` C3, C6
- `rules.md` BR11.1, BR11.2, BR13.2, BR14.1
