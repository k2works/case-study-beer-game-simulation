# Security Requirements - u1-walking-skeleton

## Authentication and Credential Protection

| ID | Requirement | Verification |
|---|---|---|
| NFR3.1 | facilitator credential と participant recovery token は独立した 128-bit 以上の CSPRNG entropy を持ち、raw value は発行時に一度だけ返す。 | entropy / uniqueness test、response snapshot test |
| NFR3.2 | credential は browser から HTTPS の secure transport だけで送信し、URL、application log、audit log、analytics、export に含めない。 | security header test、log scan、E2E network inspection |
| NFR3.3 | server は credential の keyed digest または password-hash 相当だけを保存し、constant-time comparison を使用する。 | storage inspection、unit test |
| NFR3.4 | facilitator / participant credential は game 終了 24 hours 後に失効し、deletion または explicit revoke では即時無効にする。 | trusted-clock boundary test |

## Authorization and Isolation

| ID | Requirement | Verification |
|---|---|---|
| NFR3.5 | 全 read / write / SSE subscribe で game、session、participant、role、operation authorization を server 側で検査する。 | object-level authorization matrix test |
| NFR3.6 | participant response / SSE event は自 role の state だけを含み、他 role、未来需要、credential、digest を serialization 前に除外する。 | negative contract test、cross-role fuzz test |
| NFR3.7 | join code は参加先発見にのみ使い、facilitator command や participant state access の credential として扱わない。 | unauthorized command test |
| NFR3.8 | authorization failure は protected resource の存在を推測できない `403` / `404` policy に従い、RFC 9457 body に correlation ID 以外の secret を含めない。 | API contract test |

## Input, Session, and Browser Security

| ID | Requirement | Verification |
|---|---|---|
| NFR3.9 | text、integer、identifier、header を schema validation し、quantity / payload / request size を bounded にする。 | boundary / hostile-input test |
| NFR3.10 | browser credential storage は script exposure を最小化し、CSP、CSRF protection、secure cookie / token transport を stack design で確定する。 | security configuration test |
| NFR3.11 | dependency scan、secret scan、SAST を CI で実行し、Critical / High finding を release blocker とする。 | CI evidence |

## Privacy

| ID | Requirement | Verification |
|---|---|---|
| NFR4.1 | U1 が収集する personal data は display name に限定し、credential raw value を personal record と結合して保存しない。 | schema / data-flow review |
| NFR4.2 | audit record は actor pseudonymous ID、operation、result、correlation ID、timestamp を持ち、display name と token を含めない。 | log contract test |

## Threat Priorities

- Broken object-level authorization、token theft、join-code guessing、replay、stale update、mass assignment、log leakage を primary threat とします。
- 同一 role の複数 participant は共有 decision を更新できますが、各 participant は同じ game / role membership と current version を満たす必要があります。

## Sources

- `inception/requirements-analysis/requirements.md` NFR3, NFR4
- `inception/contract-design/contract-summary.md`
- `construction/u1-walking-skeleton/functional-design/rules.md`
- `construction/u1-walking-skeleton/functional-design/functional-spec.md`
- `construction/u1-walking-skeleton/nfr-requirements/nfr-requirements-questions.md`

## Assumptions & Open Questions

- exact cookie / token storage pattern は NFR Design で threat analysis と frontend/backend topology に合わせて決定します。
