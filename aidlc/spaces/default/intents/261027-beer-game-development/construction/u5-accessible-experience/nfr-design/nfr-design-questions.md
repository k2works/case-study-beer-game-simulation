# U5 NFR Design 質問

性能と認証に関して、既存の共有契約に書かれていない設計上の境界を決めます。

## Q1. [技術担当] 入力確定の 1 秒をどう配分しますか

U5 の要件では操作開始から画面表示まで p95 1 秒以内、U1 では server 処理だけで p95 1 秒以内です。このままでは通信と描画の余裕がありません。

- A. end-to-end 1 秒を維持し、server 700 ms、通信 200 ms、描画 100 ms を初期設計予算とする。75 user 負荷で実測し、配分を調整する
- B. server p95 1 秒を維持し、browser 表示の end-to-end 目標を 2 秒に緩める
- X. Other (please specify)

[Answer]: A. end-to-end 1 秒を維持し、server 700 ms、通信 200 ms、描画 100 ms を初期設計予算とする。75 user 負荷で実測し、配分を調整する

## Q2. [セキュリティ担当] cookie を使う変更操作の CSRF 対策

復帰資格は HttpOnly、Secure、SameSite cookie に置きます。作成・参加・入力・進行役操作・export・削除 retry などの変更操作を、同一 origin の browser UI から送る前提で防御方法を決めます。

- A. SameSite=Lax、Origin / Referer 検査、state-changing request の CSRF token を組み合わせる
- B. SameSite=Strict、Origin / Referer 検査を使い、CSRF token は用いない
- X. Other (please specify)

[Answer]: B. SameSite=Strict、Origin / Referer 検査を使い、CSRF token は用いない
