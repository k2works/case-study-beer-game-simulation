## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-13T02:21:08Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/security-design.md > NFR6.4 無効な token の同一の応答 / NFR6.1 / NFR6.10 | 無効な資格情報の固定の応答は、理由「この端末の参加情報は使えません」、直し方「進行役に担当者の入れ替えを依頼してください」という参加者の token 向けの文言になっている。一方で `Authorization` ヘッダは参加者の token、進行役用コード、観察者用コードの 3 種類を運ぶ。ヘッダだけでどの種類かをどう見分けるか（接頭辞、照合の順、どちらの表を先に引くか）が書かれていない。観察者用コードを打ち間違えた人に、入れ替えを依頼せよという案内が出る。NFR6.10 は「無効なコードは理由を示す」としているため、画面が固定の応答のまま理由を示せるのか、別の応答になるのか、どちらにも読める。別の応答にすると、種類によって応答が変わり、判定の順が応答の違いを生む。 | 資格情報の種類の判定方法（形式または照合の順）を 1 つに決めて書く。参加者の token、進行役用コード、観察者用コードの無効の応答を、種類ごとの文言とするのか、1 つの共通の文言とするのかを決める。種類の判定が応答の違いから種類や存在を明かさないことと、観察者の入口が理由を示せることを両立する形にし、試験の項目に加える。 | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/security-design.md > NFR6.7 入口の構造 / NFR6.8 網羅試験（認可を行う位置） | 認可を要求のどの段階で行うかが書かれていない。要件は資格情報の特定、権限、入力の検証（422）、状態の検査（409）の順で、認可を必ず先に行うとしている（BR19.1）。U1 と U3 は認可、占有、再送の照合、状態の検査の順で、zod の検証は占有の前に行う（422 が占有より前に出る）。Fastify のスキーマ検証や本文の zod 検証を `preHandler` の後ろに置くと、権限のない人に 422 が先に返りうる。存在しないゲームの識別子で 404 が先に返るのか 403 になるのかも、設計に書かれていない（網羅試験は「別のゲームの資格情報」しか対象にしない）。 | 認可を `onRequest` または `preValidation` の位置に置き、認可の通過後にだけ zod と状態の検査を行うことを書く。存在しないゲームと別のゲームの識別子で同じ 403 になること、認可が U1 と U3 の判定の順（認可、占有、再送の照合、状態の検査）の先頭に入ることを書く。網羅試験の表に、存在しないゲームの識別子の場合と、不正な本文での 403 の優先を加える。 | New |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/scalability-design.md > NFR4.2 窓の大きさ ／ reliability-design.md > 窓の掃除 ／ security-design.md > NFR7.1 | 窓の削除の設計が上流の確認方法と合わない。要件の NFR7.1 は、参加の要求のたびに全接続元の 60 秒を過ぎた行を削除し、表の行数は直近 60 秒の試行の数を超えず、「IPv6 を回転させた 1,000 件の試行の 60 秒後に行が残らない」試験を求める。設計（Q2 の A）は、要求では自分の接続元の行だけを削除し、全接続元の削除は 10 分ごとの掃除に移した。そのため 60 秒後に行が残らない試験は成り立たない（最大約 10 分残る）。NFR4.2 は同じ欄で「掃除の周期の間に残る分を足した範囲」と「参加の要求が続いている間は直近 60 秒の試行の数を超えない」と書いており、後者は他の接続元の古い行が残るため誤りである。掃除の試験（周期、起動時、失敗時の再実行、複数台での重なり）はどの設計文書にも無い。 | 上流の NFR7.1 の（b）との差を設計に明記し、試験を「掃除を実行したあとに行が残らない」「掃除が無い間は最大でも約 10 分残る」の形に置き換える。NFR4.2 の誤った一文を直す。掃除の試験（IPv6 を回転させた 1,000 件、起動時の削除、失敗のログ、2 台で重なっても結果が同じ）を設計に加える。 | New |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/security-design.md > NFR6.5 / reliability-design.md > 窓の掃除 / performance-design.md > NFR3.3 | 窓の時刻（`attempted_at`、60 秒の判定、`last_used_at` の 1 分の条件）の時計の出どころが書かれていない。信頼性の設計は注入した時計（アプリケーション側）を使うとしており、アプリケーションが複数台で時刻がずれると、窓の通算や「最新 11 件」の順序、1 分の間引きが揺らぐ。トランザクションの `now()` はロックの待ちの前の時刻になる。 | 窓と間引きの時刻を、データベースの時計（ロック取得後の `clock_timestamp()`）に統一するか、アプリケーションの時計で良い理由と許容するずれを書く。 | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/security-design.md > NFR6.4 | 「状態コード、本文、ヘッダが完全に同じ」と書かれているが、要求の識別子や日時のヘッダは毎回異なる。試験の比較の対象が定まらない。 | 比較の対象を、状態コード、本文（要求の識別子を除く）、固定のヘッダに限ると書く。 | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/security-design.md > NFR6.5 手順（4）「新しい 11 件を超える行を削除」 | 「接続元ごとに新しい 11 件を超える行を削除する」の実現（SQL の形、同じ時刻の行の順序）が書かれていない。掃除の `ctid` の形だけが示されている。 | 削除の文（例: 順序付きで 11 番目以降を削除）を 1 つ示し、同じ時刻の行の扱いを決める。 | New |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/logical-components.md > 共有の資源 | 窓のロックの鍵（`hashtextextended(source_key, 0)`）が、ゲームの行の占有と「別の鍵」と書かれているが、U1 の占有がアドバイザリロックを使う場合は同じ鍵の空間で衝突しうる。衝突は待ちが増えるだけだが、「窓のロックはゲームの書き込みを待たせない」という断定は保証されない。 | 窓のロックに専用の名前空間（2 つの整数の形の鍵）を使うか、U1 の占有が行ロックであることを確かめて書く。 | New |
| R-08 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/observability-design.md > NFR9.1 と NFR9.3 ／ reliability-design.md > 障害の扱い（掃除の失敗） | NFR9.1 は掃除と更新の失敗を「警告の水準」で出し、NFR9.3 は「警告を持たない」とする。前者はログの水準、後者は通知の意味で、語が衝突する。通知が無いと、信頼性の設計が述べる「24 時間を超える前に気づける」を誰が満たすのかも不明である。 | ログの水準（warn）と通知（alert）を別の語で書き分ける。掃除の失敗に気づく手段を、Operation への引き継ぎ事項として明記する。 | New |
| R-09 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/performance-design.md > NFR3.1 観察者の投影 | 観察者の投影の `inputtedRoleCount` と、準備中や第 1 週の確定前の値（確定済みの週が無い場合）の読み取り元が書かれていない。`week_records` の SUM の説明は、入力済みの数に使えない。 | `inputtedRoleCount` の読み取り元と、確定済みの週が無いときの値（0）を書く。 | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| traceability.json の ID の突合（nfr-requirements の NFRx.y との比較） | 36 件すべて一致、target は実在する設計文書の要件行に対応 | 一覧は網羅されている。NFR10 と NFR11 は上流で N/A のため対象外 |
| 技術の検査（PostgreSQL の `lock_timeout` とアドバイザリロック、`DELETE ... ctid ... FOR UPDATE SKIP LOCKED`、Fastify の数値 `trustProxy`） | 設計の記述は成り立つ。`lock_timeout` はアドバイザリロックの待ちに効き、SQLSTATE は 55P03。数値の `trustProxy` は右から数える段数として働く | 方式そのものの欠陥は無し。ただし、設定の段数が実際の段数より大きいと、利用者が付けた転送元のヘッダを信じてしまうため、起動後の確認はデプロイ側の前提に残る |
| テストの実行 | 実行せず（NFR Design の段階で、実装と試験のコマンドが無い） | 実行の対象外 |

### Summary

方式（接続元ごとのアドバイザリロック、`lock_timeout` 3 秒と 503、応答のあとの条件付き更新、専用の投影の型、経路の表）は妥当で、NFR の ID は漏れなく割り当てられています。ただし、無効な資格情報の種類の判定と応答、認可の位置（422、404 より先）、窓の削除と上流の保持の試験の食い違いの 3 点は、開発者が推測で補う必要があるため、直してから再レビューしてください。
