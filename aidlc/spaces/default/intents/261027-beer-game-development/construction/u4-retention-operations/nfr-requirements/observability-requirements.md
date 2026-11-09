# Observability Requirements - U4 Retention Operations

## Signals

| ID | Requirement | Target |
|---|---|---|
| NFR7.1 | scheduler、C4 publish、C5 consume、retry、terminal transition を correlation ID 付きで記録する | 100% event coverage |
| NFR7.2 | permanent failure または retry 枯渇から 5 分以内に運営者へ通知する | alert delivery SLI |
| NFR7.3 | deletion age、queue lag、owner completion、retry count、failure code を dashboard 化する | current and 30-day trend |
| NFR7.4 | log と trace に PII、token、credential digest、deleted payload を含めない | automated redaction scan |

## Alerts

24 時間 SLO breach、queue oldest age、DLQ 増加、receipt persistence failure、期限切れ receipt cleanup failure を alert 対象にします。

## Sources

- `functional-design/functional-spec.md`
- `requirements.md` NFR7
