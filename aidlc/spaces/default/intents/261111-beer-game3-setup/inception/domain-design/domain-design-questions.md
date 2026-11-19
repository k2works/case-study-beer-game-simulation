# Domain Design 質問

要件（`requirements.md`）とストーリー（`stories.md`）を、実装する部品（コンポーネント）に分けるための確認です。部品は「自分たちが書くコード」で、データベースなどは部品が使う依存先です。デプロイの形（1 つにまとめるか分けるか）は、次の Units Generation で決めます。

前回の作業（beer-game-development）の決定として、「週次進行と永続状態は GameSession が所有し、副作用のない決定論的計算を SimulationEngine に分離する」を引き継ぎます。これは質問しません。

## Q1. [アーキテクト] 部品の分け方

業務の責務をどう部品に分けますか？

A. 5 つに分ける。ゲーム全体の状態と進行を持つ GameSession、副作用のない週次計算の SimulationEngine、コードと token の発行・検証と役割別の見せ方を担う AccessControl、結果の比較と出力を担う Reporting、保持期間と自動終了と削除を担う Retention
B. 2 つにまとめる。GameSession（状態、進行、アクセス、結果、保持をすべて持つ）と SimulationEngine（週次計算）
C. 6 つ以上に細かく分ける。A の GameSession を、参加者と役割の管理（Roster）、週の進行（Progress）、操作の履歴（AuditLog）に分ける
X. Other (please specify)

[Answer]: A

## Q2. [アーキテクト] 役割別の見せ方を担う場所

プレイ中、他の役割の在庫や受注残などを見せないこと（FR4.1〜FR4.5）は、最も守りたい制約の一つです。どの部品が担いますか？

A. AccessControl が、GameSession の状態から、呼び出した人（参加者、進行役、観察者）ごとの見せ方（役割別の投影）を作る。GameSession は全員分の状態を持つが、外へは直接出さない
B. GameSession が、呼び出した人の権限を受け取り、見せてよい情報だけを返す
X. Other (please specify)

[Answer]: A

## Q3. [アーキテクト] 整合性を守る単位（集約）

週の確定は、一度だけ、原子的に行う必要があります（FR9）。整合性を守る単位をどこに置きますか？

A. ゲーム全体を 1 つの集約にする。週の確定は、ゲームの集約を 1 回の保存で更新する。1 ゲームの規模は小さい（50 週、4 役割）ので、競合は 1 ゲームの中だけで起きる
B. ゲームと週の記録を別の集約にする。週の確定は、2 つの集約を調整して更新する
X. Other (please specify)

[Answer]: A

## Q4. [アーキテクト] 操作の履歴の持ち方

設定変更、役割変更、代理入力、週確定、停止、再開、終了の履歴を残します（NFR9）。履歴はどう持ちますか？

A. ゲームの集約の一部にして、操作と同じ保存の中で残す。操作が成功したときだけ、履歴も残る
B. 別の部品（AuditLog）に分け、操作の後に非同期で残す
X. Other (please specify)

[Answer]: A

## Q5. [プロダクト] 観察者の入り方

観察者は、進行中のゲームでも入る必要があります。参加コードは、進行中は新しい参加を拒否する（FR2.2）ため、使えません。上流の資料には、観察者の入り方が決まっていません。どうしますか？

A. ゲーム作成時に、観察者用のコードを、参加コードとは別に発行する。進行中でも使える。観察者用のコードで入った人は、入力できない
B. 進行役が、必要なときに、観察用のコードを発行する。使い終わったら無効にできる
C. 観察者は準備中だけ、参加コードで入る。進行中の途中参加はできない
X. Other (please specify)

[Answer]: A

## Consolidated Summary Confirmation

- 部品は 5 つに分ける: GameSession（ゲーム全体の状態と進行）、SimulationEngine（副作用のない週次計算）、AccessControl（コードと token の発行・検証、役割別の見せ方）、Reporting（結果の比較と出力）、Retention（保持期間、自動終了、削除）
- 役割別の見せ方は AccessControl が担う。GameSession の状態から、呼び出した人ごとの投影を作り、GameSession は外へ直接出さない
- 整合性の単位は、ゲーム全体を 1 つの集約にする。週の確定は、ゲームの集約を 1 回の保存で更新する
- 操作の履歴は、ゲームの集約の一部にして、操作と同じ保存の中で残す
- 観察者は、ゲーム作成時に、参加コードとは別の観察者用コードを発行する。進行中でも使え、入力はできない

Does this all look correct before I generate the artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
