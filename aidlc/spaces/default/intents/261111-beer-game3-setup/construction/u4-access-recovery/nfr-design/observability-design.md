# 観測性の設計 - U4 u4-access-recovery

`observability-requirements.md`（NFR9.1〜NFR9.5）を満たす設計です。要求の識別子、構造化ログの形式と許可リスト、ヘルスチェックは U1 の `observability-design.md` を、操作の履歴は U3 の `observability-design.md` を引き継ぎます。U4 は、増える 3 種類の拒否のログと件数を設計します。

## 設計

| 要件 | 解決 |
| :--- | :--- |
| NFR9.1 拒否のログ | 入口の共通のエラー処理が、資格情報の拒否を分類して情報の水準で記録する。`invalid_token` は `Authorization` ヘッダの資格情報（参加者の token、進行役用コード、観察者用コード）が無効なとき、`invalid_code` は参加コードによる参加の試行が無効なとき、`rate_limited` は 429 のとき。出す項目は許可リスト（時刻、要求の識別子、操作、結果の種類、応答時間、接続元の正規化したキー、ゲームの識別子（特定できるとき））だけで、資格情報の文字列は出力の対象にしない（U1）。資格情報は有効だが権限のない要求（403 `forbidden`）は、既存の結果の種類で出す。lastUsedAt の更新の失敗と窓の掃除の失敗は、それぞれ別の種類（`last_used_update_failed`、`join_attempt_cleanup_failed`）で、ログの水準 warn に出す（通知ではない） |
| NFR9.2 件数のカウンタ | プロセス内に、種類ごとの件数のカウンタ（`invalid_token`、`invalid_code`、`rate_limited`）を持ち、拒否のたびに 1 増やす。カウンタの名前に接続元を含めない（種類の数を固定する）。収集と表示の基盤（エクスポートの方法）は Operation で決める。U4 は、カウンタを読み出す関数と、増えることの試験までを作る |
| NFR9.3 通知（alert）なし | 通知の定義を持たない。`rate_limited` の増加や、掃除の失敗（warn のログ）を知らせる通知は、本番運用で必要になったときに Operation で足す。ログの水準 warn とは別である |
| NFR9.4 見直しの根拠 | 接続元のキーを許可リストに含めるため、同じキーの 429 がログに並ぶ。同じ NAT の誤拒否や、プロキシの設定の誤り（全員が 1 つの接続元）を、キーの分布から見つけられる。ログの接続元の保持期間は Operation で定め、ゲームの保持期間（既定 30 日）を超えない |
| NFR9.5 履歴に残さない | 拒否と lastUsedAt の更新は、GameSession を通らない経路（入口の共通のエラー処理と応答後の処理）で扱い、`operation_log_entries` に書く関数を呼ばない。試験は、拒否と延長のあとに履歴を取得して行が増えないことを確かめる |

## ログと履歴の使い分け

| | 構造化ログ | 操作の履歴（U3） |
| :--- | :--- | :--- |
| U4 の対象 | 3 種類の拒否、権限のない要求の拒否、lastUsedAt と掃除の失敗 | 対象にしない |

## 上流の資料

`observability-requirements.md`、`rules.md`、`functional-spec.md`、`nfr-design-questions.md`
