# NFR Requirements 質問 - U1 u1-walking-skeleton

U1（薄い一通り）の非機能の要件を定めるための確認です。応答性、同時利用、セキュリティ、可用性などの数値は、`requirements.md` の NFR1〜NFR11 で決まっているので質問しません（仮の値は、この工程で U1 に当てはめます）。ここでは、まだ決まっていない、技術の選択と、U1 の設計に影響する点だけを聞きます。

## Q1. [アーキテクト] 技術スタック

U1 は最初の動くコードで、以降の Unit がその上に積まれます。どの構成で作りますか？ team の方針は、実行環境が Node.js 26、データベースが PostgreSQL 18、Node.js の ESM と camelCase の継続、formatter・linter・type-check の導入です。

A. beer-game2 と同じ構成を引き継ぐ。TypeScript（strict）、Fastify、PostgreSQL と node-pg-migrate、zod、React と Vite、Vitest、Playwright、ESLint、Prettier。ただし、コードは複製せず、版は実装の時点で公式情報を確かめて決める
B. 別の構成にする（たとえば、画面とサーバーを 1 つにまとめる全部入りのフレームワーク）
X. Other (please specify)

[Answer]: A

## Q2. [デベロッパー] 画面の取り直しの周期

画面が状態を取り直す周期の既定を、何秒にしますか？ 契約ではポーリング（定期的な取り直し）としました。週確定後 2 秒以内の反映が目標です（NFR3、仮の値）。15 チーム（1 チーム 5 人）が同時に使うと 75 台の画面が取り直します。

A. 2 秒。目標に最も近い。75 台で毎秒およそ 38 回の取得
B. 3 秒。毎秒およそ 25 回。週確定後の反映は最大 3 秒かかり、目標の 2 秒を超える場合がある
C. 5 秒。毎秒およそ 15 回。反映は最大 5 秒かかる
X. Other (please specify)

[Answer]: A

## Q3. [セキュリティ] 再表示できるコードの暗号化

参加コードと観察者用コードは、進行役が共有するために再表示できる形で保存します（Functional Design の決定）。どう暗号化しますか？

A. アプリケーションの鍵で暗号化する（AES-256-GCM）。鍵は環境変数か秘密情報の管理から渡し、ソースや DB に置かない。鍵を変えるときは、再暗号化の手順を用意する
B. 暗号化しない。DB の保護に任せる
X. Other (please specify)

[Answer]: A

## Q4. [運用] U1 で作る観測性の範囲

U1 の時点で、どこまでの観測性（ログ、指標、ヘルスチェック）を作りますか？ 運用の本格的な設定は後の Operation で行います。

A. 最小。要求ごとの識別子つきの構造化ログ（JSON）と、ヘルスチェックの入口。ログに資格情報（コード、token）を出さない
B. A に加えて、エラー率と応答時間の指標も出す
X. Other (please specify)

[Answer]: A

## Q5. [アーキテクト] 2 秒以内の反映を満たす方法（レビューの指摘への追加の質問。Q2 の周期を見直す）

画面を 2 秒おきに取り直すと、週確定の処理（約 0.5 秒）を足して最大 2.5 秒かかり、「週確定後 2 秒以内に反映」（NFR3）を満たせません。どうしますか？

A. 取り直しの周期を 1 秒にする。1 秒 + 確定の処理 0.5 秒で 2 秒以内に収まる。通常の 75 台で毎秒およそ 75 回、最大想定の 270 台で毎秒およそ 270 回の取得になる
B. サーバーからの通知（Server-Sent Events）にする。Contract Design の決定（ポーリング）を変える
C. 要件を緩める。進行役の画面は確定の応答で即時、ほかの画面は 95 パーセンタイルで 3 秒以内にし、`requirements.md` の NFR3 との差を記録する
X. Other (please specify)

[Answer]: A

## Q6. [プロダクト] 仮の値の確定

`requirements.md` の「仮の値」の NFR5、NFR6、NFR7 を、この工程で確定します。切断は 30 分以内、復帰用 token は最後の操作から 24 時間、無効なコードの試行は同じ接続元から 1 分あたり 10 回、保持期間の既定は終了後 30 日、放置されたゲームの自動終了は最後の操作から 30 日です。この値で確定してよいですか？

A. この値で確定する。実装する Unit（U4、U5）を明記する
B. 変える（Other に、変える値を書く）
X. Other (please specify)

[Answer]: A

## Consolidated Summary Confirmation

Does this all look correct before I generate the artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
