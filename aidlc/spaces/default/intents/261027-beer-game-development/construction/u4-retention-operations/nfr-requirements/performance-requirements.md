# Performance Requirements - U4 Retention Operations

## Targets

| ID | Requirement | Measure |
|---|---|---|
| NFR1.1 | retention status query は通常負荷で p95 1 秒以内とする | HTTP server timing |
| NFR1.2 | 期限到達した deletion saga の 99% を 24 時間以内に完了する | `completedAt - deleteAfter` |
| NFR1.3 | scheduler scan は 15 team 規模で 5 分以内に 1 cycle を完了する | scheduler duration |

## Verification

15 team と 150% burst の due policy を投入し、status query、scheduler、owner completion の latency を計測します。

## Sources

- `functional-design/functional-spec.md`
- `requirements.md` NFR1
