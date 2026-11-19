# Units Generation Questions

## Q1. [Deployment model] 初期の実行単位

domain component を初回 release でどのように deploy 可能な unit へまとめますか？

- A. modular monolith の application service と browser UI を中心にし、pure SimulationEngine は library とする
- B. domain component ごとに独立 service として deploy する
- C. application 全体を 1 つの service unit にまとめる
- X. Other (please specify)

[Answer]: A. modular monolith の application service と browser UI を中心にし、pure SimulationEngine は library とする

## Q2. [Unit granularity] 後続 capability の分け方

walking skeleton 後の work unit をどの粒度で分けますか？

- A. 継続・復旧、学習 view、保持・削除、UX 完成の capability slice に分ける
- B. GameConfiguration、Participation、GameSession、LearningView の domain component ごとに分ける
- C. backend、frontend、database、CI の技術 layer ごとに分ける
- X. Other (please specify)

[Answer]: A. 継続・復旧、学習 view、保持・削除、UX 完成の capability slice に分ける

## Q3. [Walking skeleton] 最初の integrated slice

最初の Unit が完成した時点で、どの範囲を実動させますか？

- A. 1 ゲーム作成、4 役割参加、1 週入力・確定、役割別状態表示を real persistence まで接続する
- B. 週次計算 library と API だけを完成し、UI と persistence は後続にする
- C. UI prototype と in-memory simulation で demo し、real persistence は後続にする
- X. Other (please specify)

[Answer]: A. 1 ゲーム作成、4 役割参加、1 週入力・確定、役割別状態表示を real persistence まで接続する

## Assumptions & Open Questions

- dependency artifact は topology のみを定義し、経済的な実装順序や critical path は Delivery Planning で決定する。
- component ownership は Domain Design の決定を維持し、Unit は delivery capability のまとまりとして component を横断できる。
