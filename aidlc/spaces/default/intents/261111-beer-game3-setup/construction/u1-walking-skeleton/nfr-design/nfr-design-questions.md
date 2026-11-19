# NFR Design 質問 - U1 u1-walking-skeleton

NFR の要件を満たす設計のうち、人が選ぶ必要がある 2 点を確認します。ほかの設計は、要件から導いて書きます。

## Q1. [アーキテクト] ゲーム単位の直列処理の方式

同じゲームへの書き込みを 1 つずつ順に処理する方式を選びます（待ちは最大 3 秒、超えたら 503）。アプリケーションが複数になっても成り立つ必要があります。

A. データベースの行の占有。書き込みの処理の始めに、そのゲームの行を占有する。仕組みが単純で、保存の版の検査とも合う。待つ間は接続を 1 つ使う
B. アドバイザリロック。ゲームの識別子でロックを取る。行を占有しないが、ロックの取り忘れに注意が要る
X. Other (please specify)

[Answer]: A

## Q2. [セキュリティ] 照合用の鍵（HMAC）を変えるとき

参加コードの照合用の鍵付きハッシュの鍵を変えると、保存済みのコードを照合できなくなります。どう扱いますか？

A. 鍵に識別子を付け、移行の間は旧鍵と新鍵の両方で照合する。移行が終わったら旧鍵を外す
B. 鍵は変えない前提にする。漏えいしたときは、進行中のゲームを終了させ、新しい鍵で作り直す
X. Other (please specify)

[Answer]: A

## Consolidated Summary Confirmation

Does this all look correct before I generate the artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
