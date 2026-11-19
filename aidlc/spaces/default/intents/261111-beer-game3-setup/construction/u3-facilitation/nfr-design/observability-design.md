# 観測性の設計 - U3 u3-facilitation

`observability-requirements.md`（NFR9.1〜NFR9.3）を満たす設計です。要求の識別子、構造化ログの形式、許可リスト、ヘルスチェックは、U1 の `observability-design.md` を引き継ぎます。拒否された進行役の操作のログ（NFR6.6、NFR6.7）は `security-design.md` が持ちます。

## 設計

| 要件 | 解決 |
| :--- | :--- |
| NFR9.1 7 種類の履歴 | GameSession に、履歴を足す関数 `appendLog(tx, game, entry)` を 1 つだけ持つ。作成（setting）、割当てと付け替えと入れ替え（roleChange）、代理入力（proxyInput）、週の確定（weekConfirm）、一時停止（pause）、再開（resume）、終了（end）の各コマンドが、占有したトランザクションの中でこの関数を呼ぶ。履歴を足さずに状態を変えるコマンドを作れないよう、状態を変える保存の関数は、履歴の引数を必須にする |
| NFR9.2 追記専用 | アプリケーションは、履歴の表に対して INSERT と SELECT だけを書く。UPDATE と DELETE の文を持たない（削除はゲームの削除に連動する外部キーの連鎖で行う）。データベースの権限とトリガーは変えない（Q2 の A）。自動試験で、履歴の表に対する UPDATE と DELETE の文がソースにないことを確かめる静的な検査と、連番が 1 から欠けず重複しないことの検査を持つ。連番の検査は、最終週の確定で 1 トランザクションに足される 2 件（weekConfirm、続く end）が連続した番号になる場合を含む。連番は `games.next_log_sequence` で採番する |
| NFR9.3 取得と秘匿 | 履歴の取得は、進行役の判定を通した入口だけが読む。応答は sequence の昇順。detail は zod の厳密な型で保存時に検証され、資格情報の値を持たない。時刻は、注入した時計から得る |

## 履歴の項目の対応

| kind | きっかけとなるコマンド | actorKind | detail |
| :--- | :--- | :--- | :--- |
| setting | create | facilitator | 週数、初期値、費用単価、種別、需要系列の長さと仮の既定か |
| roleChange | assignRole、replaceAssignee | facilitator | change（assign、reassign、replace）、参加者のラベル、元と先の役割、入れ替え前の担当者、そのときの状態 |
| proxyInput | submitDecision（進行役用コード） | facilitator | 値（week と role は列） |
| weekConfirm | confirmWeek | facilitator | 確定した週 |
| pause、resume | pause、resume | facilitator | そのときの週 |
| end | end（facilitator）、confirmWeek の最終週（finalWeek） | facilitator または system | reason と週 |

## ログと履歴の分担

- 障害の調査と応答時間の測定は、構造化ログ（U1）が担う。拒否された操作の記録も、構造化ログに残す。
- 誰が何をしたかの監査は、履歴が担う。成功した 7 種類の操作だけが、ゲームの集約の一部として残る。
- 指標、アラートのしきい値、ダッシュボードは、後の Operation で定める。

## 上流の資料

`observability-requirements.md`、`functional-spec.md`、`rules.md`、`entities.md`
