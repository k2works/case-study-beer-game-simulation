# Domain Design Questions

## Q1. [Component boundary] 週次計算の分離

週確定の状態管理と、在庫・受注残・遅延・費用の決定論的計算をどの境界にしますか？

- A. `GameSession` が進行と状態を所有し、pure な `SimulationEngine` を呼び出す
- B. 週次進行と計算を 1 つの `GameSession` component にまとめる
- C. 在庫、注文、配送、費用を個別 component に分ける
- X. Other (please specify)

[Answer]: A. `GameSession` が進行と状態を所有し、pure な `SimulationEngine` を呼び出す

## Q2. [Entity ownership] 参加者と復帰 token

参加、役割割当て、復帰 token の所有をどの境界に置きますか？

- A. `Participation` component が Participant、RoleAssignment、RecoveryCredential を所有する
- B. `GameSession` component が参加情報も含めてすべて所有する
- C. 汎用 Identity component を設け、account なしの参加者もそこで管理する
- X. Other (please specify)

[Answer]: A. `Participation` component が Participant、RoleAssignment、RecoveryCredential を所有する

## Q3. [Read model] 観察・振り返り・export

プレイ中の情報制約と終了後の全体開示をどのように分離しますか？

- A. `GameSession` の event から `LearningView` が用途別 read model を構築する
- B. `GameSession` の entity を各画面が権限に応じて直接読む
- C. 観察、振り返り、export をそれぞれ独立 component に分ける
- X. Other (please specify)

[Answer]: A. `GameSession` の event から `LearningView` が用途別 read model を構築する

## Established constraints

- component は論理的な code 境界であり、database、queue、cache は外部依存として扱う。
- entity は必ず 1 component だけが所有する。
- deployment topology、technology stack、具体的な schema 型は後続 stage で決める。
- `SimulationEngine` は同じ入力から同じ結果を返す副作用のない計算境界とする。

## Assumptions & Open Questions

- 需要数・発注数・生産要請数の上限値は Functional Design で確定する。
- JSD 教材の具体的な需要系列は教材照合後に `GameConfiguration` の preset として確定する。
