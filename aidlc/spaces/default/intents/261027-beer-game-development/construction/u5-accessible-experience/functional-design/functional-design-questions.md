# Functional Design Questions - U5 Accessible Experience

## Q1. 200% zoom と小画面の操作

Refined Mockups は 767 px 以下で新規作成や週確定を案内だけに制限する一方、200% zoom では操作を失わないとしています。どちらを優先しますか。

- A. zoom 時も全操作を維持し、実際の小画面は閲覧中心とする
- B. CSS viewport 幅だけで制限し、zoom 時も操作を制限する
- C. 全画面幅で全操作を提供する
- X. Other (please specify)

[Answer]: A

## Q2. 週次状態の更新方式

2 秒以内の画面反映と自動更新の停止を両立する方式を選んでください。

- A. SSE で push し、切断時は 1 秒 polling に fallback。利用者が自動更新を停止できる
- B. 常に 1 秒 polling。利用者が自動更新を停止できる
- C. 手動更新のみ
- X. Other (please specify)

[Answer]: A

## Q3. 振り返りの初期表示

chart と同じ値を持つ table を常設する前提で、最初にどちらを主表示しますか。

- A. chart と table を同時表示し、table へ直接移動できる
- B. table を主表示し、chart を任意に展開する
- C. chart を主表示し、table は切替 button で表示する
- X. Other (please specify)

[Answer]: A

## Sources

- `inception/refined-mockups/mockups.md`
- `inception/refined-mockups/interaction-spec.md`
- `inception/refined-mockups/accessibility-checklist.md`
- `inception/requirements-analysis/requirements.md` NFR1、NFR5

## Assumptions & Open Questions

- 200% zoom では全操作を維持し、実際の小画面は閲覧中心とします。
- SSE で更新し、切断時は 1 秒 polling に fallback します。利用者は自動更新を停止できます。
- 振り返りでは chart と同じ値の table を同時表示します。
