# Units Generation 質問

部品（`components.md`）を、実装とデプロイの単位（Unit）にまとめるための確認です。この工程が決めるのは Unit の境界と依存の形（どれがどれに依存できるか）で、実装の順番は次の Delivery Planning で決めます。team の方針では、最初に作る Unit は「1 ゲーム、4 役割、1 週分を確定して状態を表示する」薄い一通り（ウォーキングスケルトン）です。

## Q1. [アーキテクト] Unit の境界の取り方

部品を Unit にまとめるとき、境界をどう取りますか？ 先頭の Unit は、最後まで通して動く最小の一通りにする必要があります（team の方針）。

A. 縦に切る。先頭の Unit が、薄い一通り（ゲーム作成、参加、役割割当て、開始、1 週の入力と確定、状態の表示）を、必要な部品の最小の部分を使って最後まで通す。後続の Unit が、週次ルールの完成、運営操作、復帰と権限、結果と出力、保持と削除を足していく
B. 部品ごとに切る。SimulationEngine、GameSession、AccessControl、Reporting、Retention、画面を、それぞれ 1 つの Unit にする。ただし、先頭の Unit が単独では動かないため、薄い一通りが最後の Unit まで完成しない
X. Other (please specify)

[Answer]: A

## Q2. [アーキテクト] デプロイの形

部品をどのデプロイの単位にまとめますか？ 保持と自動終了の定期処理（Retention）、API、画面の配信が候補です。データベースは PostgreSQL です。

A. 1 つのデプロイ単位にまとめる。API、画面の配信、定期処理を 1 つのアプリケーションとして動かす
B. 2 つに分ける。API と画面の配信を 1 つ、定期処理を別の起動（スケジュール）にする
C. 3 つに分ける。API、画面、定期処理をそれぞれ独立してデプロイする
X. Other (please specify)

[Answer]: A

## Q3. [デリバリー] Unit の細かさ

Unit をどのくらいの細かさにしますか？ 細かいほど、1 つの Unit は小さく試験しやすくなりますが、Unit 間の調整が増えます。

A. 粗め（5〜6 個）。薄い一通り、週次ルールの完成、運営操作、復帰と権限、結果と出力と保持、のように、利用の流れに近い単位にする
B. 細かめ（8〜10 個）。A の各 Unit を、さらに機能ごとに分ける
X. Other (please specify)

[Answer]: A

## Consolidated Summary Confirmation

Does this all look correct before I generate the artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
