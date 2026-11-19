# External Dependency Map - ビールゲームシミュレーション

## External Dependencies

| ID | Dependency | Owner | Lead time | Blocks | Ready condition | Slip response |
|---|---|---|---|---|---|---|
| ED-1 | JSD 改訂版教材と照合した preset demand series、initial inventory、delay、cost values | 教材確認を行う進行役 / product owner | U1 implementation 前 | B1 の JSD 準拠受入、B1 以降の正式 release | version / source と共に値が承認され、golden fixture に固定される | custom series で architecture、transaction、UI、test infrastructure を先行し、JSD 準拠の受入と release 判定を保留する |

## Internal Gated Items

以下は外部依存ではありませんが、Bolt の開始を制約します。

| Item | Owner | Blocks | Exit condition |
|---|---|---|---|
| C1 schema / security / idempotency detail | U1 | B1 completion、B5 integration | OpenAPI contract と contract tests が確定する |
| C2 timeout / retry / reconciliation、U2→U5 contract | U1 / U2 | B2 completion、B5 integration | Functional / NFR Design と compatibility test が確定する |
| C3 event-type payload schema | U1 / U3 | B3 implementation | AsyncAPI schema と fixtures が確定する |
| C6 schema / security / failure contract | U3 | B3 completion、B5 integration | OpenAPI contract と contract tests が確定する |
| C4 / C5 saga terminal behavior と receipt ownership | U4 | B4 implementation | state machine、deadline、retry cap、receipt lifecycle が確定する |

## Monitoring

- ED-1 は B1 開始時に確認し、未確定なら slip response を適用します。
- internal gated item は該当 Bolt の Functional / NFR Design review で閉じます。
- 新たな external API、data window、approval、別 team hand-off は現時点ではありません。

## Sources

- `inception/requirements-analysis/requirements.md`
- `inception/units-generation/unit-of-work.md`
- `inception/units-generation/unit-of-work-dependency.md`
- `inception/contract-design/contract-summary.md`
- `inception/delivery-planning/delivery-planning-questions.md`

## Assumptions & Open Questions

- JSD 教材の利用許諾や配布条件に追加承認が必要と判明した場合は、ED-1 を分割して owner と lead time を再評価します。
