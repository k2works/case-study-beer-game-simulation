# Practices Discovery 質問

既存の確定済みの進め方（team.md）と、コード調査で見つかった事実をもとに、証拠だけでは決まらない点を確認します。

## Q1. [プロダクト] beer-game3 の範囲

調査の結果、`apps/beer-game3/` はまだなく、対象の要件定義は v1（FR-01〜15）です。beer-game2 は v2 の追加分（FR-16〜18、NFR-11〜12）を持っています。beer-game3 はどこまで作りますか？

A. v1 の要件（FR-01〜15、NFR-01〜10）だけ
B. v1 に加えて v2 の追加分（FR-16〜18、NFR-11〜12）も含める
X. Other (please specify)

[Answer]: A

## Q2. [開発者] 土台にするコード

既存の beer-game2 は、ports and adapters の構成で、週次計算が純粋関数に閉じています。beer-game3 の土台はどれにしますか？

A. beer-game2 を複製して土台にする
B. beer-game（v1）を土台にする
C. 土台なしで、1 から作る（beer-game2 の設計は参考にするだけ）
X. Other (please specify)

[Answer]: C

## Q3. [開発者] 最初に薄い一通りの動作（ウォーキングスケルトン）を作るか

最初に、薄い端から端までの一通りの動作を作りますか？ ウォーキングスケルトンとは、全体を通して動く最小の版を先に作り、本物の機能を入れる前に各部品がつながることを確かめる進め方です。現在の確定内容は「1 ゲーム、4 役割、1 週分を確定して状態を表示する」です。

A. はい。現在の内容（1 ゲーム、4 役割、1 週分）のまま作る
B. はい。ただし、土台コードと違う部分だけの最小の薄い一通りにする
C. いいえ。作らず、機能ごとに進める
X. Other (please specify)

[Answer]: A

## Q4. [品質] テストのカバレッジの基準

team の基準は「行カバレッジ 80% 以上」です。beer-game2 は、より厳しい 85/85/85/75（行・関数・文・分岐）を設定しています。beer-game3 ではどうしますか？

A. 80% の行カバレッジだけを基準にする
B. beer-game2 の 85/85/85/75 を引き継ぐ
C. 80% を下限とし、まず実測してから基準を決める
X. Other (please specify)

[Answer]: A

## Q5. [運用] CI とデプロイの設定の作り方

CI とデプロイのワークフローは、beer-game2 の名前とパスに固定されています。beer-game3 ではどうしますか？

A. beer-game3 用に別のワークフローを新しく作る
B. アプリ名を引数にして、1 つのワークフローを共用する
C. 今は決めず、技術スタックを選ぶ段階で決める
X. Other (please specify)

[Answer]: A

## Q6. [運用] ステージングの自動反映と AWS 環境

team の方針は「main に merge したら staging へ自動反映し、production は手動承認後」です。ただし beer-game2 では、staging の push 起動がコメントアウトされ、AWS 上での動作は未検証です。beer-game3 ではどうしますか？

A. 方針は変えず、beer-game3 で自動反映を実際に動くようにする。AWS は beer-game3 専用に用意する
B. 方針は変えず、AWS は beer-game2 と共用する
C. 当面は自動反映をやめ、手動のデプロイにする
X. Other (please specify)

[Answer]: A

## Q7. [開発者] Node.js と PostgreSQL の版

beer-game2 は Node 26 と PostgreSQL 18、beer-game（v1）の CI やルートの README・Dockerfile は Node 22 と PostgreSQL 16 を使っています。beer-game3 の版はどうしますか？

A. beer-game2 と同じ（Node 26、PostgreSQL 18）にそろえる
B. 長期サポート版（Node 22、PostgreSQL 16）にそろえる
C. 今は決めず、技術スタックを選ぶ段階で決める
X. Other (please specify)

[Answer]: A

## Q8. [進め方] ブランチとコミットの書き方

現在の確定内容は「develop に統合し、リリース時に main へ merge。コミットメッセージは日本語の Conventional Commits」です。beer-game3 でも変えませんか？

A. 変えない。スコープ名は `beer-game3` を使う
B. 変えない。スコープ名は付けない
C. 変える（Other に内容を書く）
X. Other (please specify)

[Answer]: A
