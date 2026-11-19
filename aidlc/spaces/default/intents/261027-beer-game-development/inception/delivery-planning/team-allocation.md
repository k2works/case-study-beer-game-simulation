# Team Allocation - ビールゲームシミュレーション

## Allocation Policy

mob は同じ delivery goal に共同で取り組む team です。classic scope では Team Formation が実行されていないため、すべての Bolt を `aidlc-developer-agent` が担当します。Unit ごとに design、BDD、implementation、verification の文脈を保持し、serial に引き渡します。

| Bolt | Unit | Owner | Execution | Required perspectives |
|---|---|---|---|---|
| B1 Core Week Flow | U1 | `aidlc-developer-agent` | Serial | domain calculation、transaction、security、UI、BDD |
| B2 Session Continuity | U2 | `aidlc-developer-agent` | Serial | recovery、concurrency、credential security、audit |
| B3 Learning View | U3 | `aidlc-developer-agent` | Serial | event projection、privacy、data visualization、export |
| B4 Retention Operations | U4 | `aidlc-developer-agent` | Serial | saga、reliability、privacy、operations |
| B5 Accessible Experience | U5 | `aidlc-developer-agent` | Serial | interaction design、accessibility、cross-browser test |

## Handoff Rules

- 各 Bolt は Given/When/Then を実装前に定義し、formatter、linter、type-check、test、coverage を通してから次へ進みます。
- B1 は walking skeleton の実動 check と human checkpoint を通過するまで B2 へ進みません。
- provider Unit は contract spec と compatibility test、consumer Unit は contract fixture を所有します。
- `develop` を integration branch とし、release 時に `main` へ merge します。
- `main` merge は staging に自動反映し、production は手動承認後に deploy します。

## Escalation

- JSD preset が確定しない場合は product owner / 進行役へ確認し、custom series で B1 の技術検証のみを継続します。
- Contract finding が未解消の場合は、該当 provider Unit の Functional / NFR Design を完了条件に含め、consumer implementation を開始しません。
- simulation の golden test、role-safe response、atomic commit のいずれかが失敗した場合は後続 Bolt を開始しません。

## Sources

- `inception/practices-discovery/team-practices.md`
- `inception/units-generation/unit-of-work.md`
- `inception/units-generation/unit-of-work-dependency.md`
- `inception/contract-design/contract-summary.md`
- `inception/delivery-planning/delivery-planning-questions.md`

## Assumptions & Open Questions

- human team の個人別割当ては対象外であり、Construction では AI owner と user approval checkpoint を用います。
