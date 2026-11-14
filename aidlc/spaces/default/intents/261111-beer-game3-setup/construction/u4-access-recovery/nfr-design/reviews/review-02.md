## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-13T02:25:19Z
**Iteration:** 2
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/security-design.md > NFR6.4 無効な token の同一の応答 / NFR6.1 / NFR6.10 | 無効な資格情報の固定の応答は、理由「この端末の参加情報は使えません」、直し方「進行役に担当者の入れ替えを依頼してください」という参加者の token 向けの文言になっている。一方で `Authorization` ヘッダは参加者の token、進行役用コード、観察者用コードの 3 種類を運ぶ。ヘッダだけでどの種類かをどう見分けるか（接頭辞、照合の順、どちらの表を先に引くか）が書かれていない。観察者用コードを打ち間違えた人に、入れ替えを依頼せよという案内が出る。NFR6.10 は「無効なコードは理由を示す」としているため、画面が固定の応答のまま理由を示せるのか、別の応答になるのか、どちらにも読める。別の応答にすると、種類によって応答が変わり、判定の順が応答の違いを生む。 | 資格情報の種類の判定方法（形式または照合の順）を 1 つに決めて書く。参加者の token、進行役用コード、観察者用コードの無効の応答を、種類ごとの文言とするのか、1 つの共通の文言とするのかを決める。種類の判定が応答の違いから種類や存在を明かさないことと、観察者の入口が理由を示せることを両立する形にし、試験の項目に加える。 | Resolved (reviewer) |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/security-design.md > NFR6.7 入口の構造 / NFR6.8 網羅試験（認可を行う位置） | 認可を要求のどの段階で行うかが書かれていない。要件は資格情報の特定、権限、入力の検証（422）、状態の検査（409）の順で、認可を必ず先に行うとしている（BR19.1）。U1 と U3 は認可、占有、再送の照合、状態の検査の順で、zod の検証は占有の前に行う（422 が占有より前に出る）。Fastify のスキーマ検証や本文の zod 検証を `preHandler` の後ろに置くと、権限のない人に 422 が先に返りうる。存在しないゲームの識別子で 404 が先に返るのか 403 になるのかも、設計に書かれていない（網羅試験は「別のゲームの資格情報」しか対象にしない）。 | 認可を `onRequest` または `preValidation` の位置に置き、認可の通過後にだけ zod と状態の検査を行うことを書く。存在しないゲームと別のゲームの識別子で同じ 403 になること、認可が U1 と U3 の判定の順（認可、占有、再送の照合、状態の検査）の先頭に入ることを書く。網羅試験の表に、存在しないゲームの識別子の場合と、不正な本文での 403 の優先を加える。 | Unresolved |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/scalability-design.md > NFR4.2 窓の大きさ ／ reliability-design.md > 窓の掃除 ／ security-design.md > NFR7.1 | 窓の削除の設計が上流の確認方法と合わない。要件の NFR7.1 は、参加の要求のたびに全接続元の 60 秒を過ぎた行を削除し、表の行数は直近 60 秒の試行の数を超えず、「IPv6 を回転させた 1,000 件の試行の 60 秒後に行が残らない」試験を求める。設計（Q2 の A）は、要求では自分の接続元の行だけを削除し、全接続元の削除は 10 分ごとの掃除に移した。そのため 60 秒後に行が残らない試験は成り立たない（最大約 10 分残る）。NFR4.2 は同じ欄で「掃除の周期の間に残る分を足した範囲」と「参加の要求が続いている間は直近 60 秒の試行の数を超えない」と書いており、後者は他の接続元の古い行が残るため誤りである。掃除の試験（周期、起動時、失敗時の再実行、複数台での重なり）はどの設計文書にも無い。 | 上流の NFR7.1 の（b）との差を設計に明記し、試験を「掃除を実行したあとに行が残らない」「掃除が無い間は最大でも約 10 分残る」の形に置き換える。NFR4.2 の誤った一文を直す。掃除の試験（IPv6 を回転させた 1,000 件、起動時の削除、失敗のログ、2 台で重なっても結果が同じ）を設計に加える。 | Resolved (reviewer) |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/security-design.md > NFR6.5 / reliability-design.md > 窓の掃除 / performance-design.md > NFR3.3 | 窓の時刻（`attempted_at`、60 秒の判定、`last_used_at` の 1 分の条件）の時計の出どころが書かれていない。信頼性の設計は注入した時計（アプリケーション側）を使うとしており、アプリケーションが複数台で時刻がずれると、窓の通算や「最新 11 件」の順序、1 分の間引きが揺らぐ。トランザクションの `now()` はロックの待ちの前の時刻になる。 | 窓と間引きの時刻を、データベースの時計（ロック取得後の `clock_timestamp()`）に統一するか、アプリケーションの時計で良い理由と許容するずれを書く。 | Resolved (reviewer) |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/security-design.md > NFR6.4 | 「状態コード、本文、ヘッダが完全に同じ」と書かれているが、要求の識別子や日時のヘッダは毎回異なる。試験の比較の対象が定まらない。 | 比較の対象を、状態コード、本文（要求の識別子を除く）、固定のヘッダに限ると書く。 | Resolved (reviewer) |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/security-design.md > NFR6.5 手順（4）「新しい 11 件を超える行を削除」 | 「接続元ごとに新しい 11 件を超える行を削除する」の実現（SQL の形、同じ時刻の行の順序）が書かれていない。掃除の `ctid` の形だけが示されている。 | 削除の文（例: 順序付きで 11 番目以降を削除）を 1 つ示し、同じ時刻の行の扱いを決める。 | Resolved (reviewer) |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/logical-components.md > 共有の資源 | 窓のロックの鍵（`hashtextextended(source_key, 0)`）が、ゲームの行の占有と「別の鍵」と書かれているが、U1 の占有がアドバイザリロックを使う場合は同じ鍵の空間で衝突しうる。衝突は待ちが増えるだけだが、「窓のロックはゲームの書き込みを待たせない」という断定は保証されない。 | 窓のロックに専用の名前空間（2 つの整数の形の鍵）を使うか、U1 の占有が行ロックであることを確かめて書く。 | Resolved (reviewer) |
| R-08 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/observability-design.md > NFR9.1 と NFR9.3 ／ reliability-design.md > 障害の扱い（掃除の失敗） | NFR9.1 は掃除と更新の失敗を「警告の水準」で出し、NFR9.3 は「警告を持たない」とする。前者はログの水準、後者は通知の意味で、語が衝突する。通知が無いと、信頼性の設計が述べる「24 時間を超える前に気づける」を誰が満たすのかも不明である。 | ログの水準（warn）と通知（alert）を別の語で書き分ける。掃除の失敗に気づく手段を、Operation への引き継ぎ事項として明記する。 | Resolved (reviewer) |
| R-09 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/performance-design.md > NFR3.1 観察者の投影 | 観察者の投影の `inputtedRoleCount` と、準備中や第 1 週の確定前の値（確定済みの週が無い場合）の読み取り元が書かれていない。`week_records` の SUM の説明は、入力済みの数に使えない。 | `inputtedRoleCount` の読み取り元と、確定済みの週が無いときの値（0）を書く。 | Resolved (reviewer) |
| R-10 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/security-design.md > NFR6.7、NFR6.8 認可の位置（共通）と NFR6.5 参加の試行の窓 | 「参加の要求は `onRequest` で窓の検査を行い、その後に本文を検証する」とあるが、窓の手順の（5）は参加コードを検証する。参加コードは `POST /games/join` の本文にあり（contract-summary.md の `/games/join`）、`onRequest` の時点では本文が解析されていないため、コードを検証できない。また、本文が欠落または形式不正（422 になるもの）の試行が窓に数えられるのか、数えられないのかが決まらない。 | 窓の手順を実行するフックの位置を、本文の解析後（例: `preValidation` または `preHandler` で、zod の形式検査のあと）に直す。形式不正の本文（コードの欠落など）を窓に数えるかを決めて書く。判定の順の記述と、網羅試験の「不正な本文でも 403 が先」の対象（資格情報を持たない参加の経路を除く）を、その位置に合わせる。 | New |
| R-11 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/performance-design.md > NFR3.1 | 「参加者の token は `return_tokens` を、進行役用コードと観察者用コードは `access_codes` を引く」と種類ごとに引き先を決める書き方で、security-design.md の NFR6.1（両方の表を引き、一致で種類を決める）と食い違う。「1 回引く検索だけ」も、実際は 2 つの表の索引を 1 回ずつ引く。 | NFR3.1 の文を、2 つの表を引く（索引の検索が 2 回）形に合わせ、取り直しの予算の内訳にも反映する。 | New |
| R-12 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/reliability-design.md > 窓の掃除の試験 | 「掃除と窓のトランザクションが同時に走っても互いを待たせない」とあるが、掃除は `FOR UPDATE SKIP LOCKED` で行を保持してから削除する。窓の手順（2）の DELETE が同じ行に当たると、掃除の 1 文が終わるまで短く待つ可能性がある。 | 「掃除は窓を待たない。窓は掃除の 1 文の間だけ待つことがあり、`lock_timeout` の範囲に収まる」と正確に書く。または試験の主張を掃除が待たないことに限る。 | New |
| R-13 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/security-design.md > NFR6.9 と observability-design.md > NFR9.1 | 出力の項目の許可リストが一致しない。security-design.md には「理由」があり、observability-design.md には「時刻」「応答時間」「結果の種類」があるが「理由」がない。 | 許可リストを 1 か所に定め、他方はそれを参照する形にする。 | New |

> R-01 Reviewer note: NFR6.1 が種類を照合の結果（2 つの表を引く）で決め、NFR6.4 が種類を含まない 1 つの共通の本文と画面側の文言の選択を定めた。衝突は 128 ビット以上の値のため無視できる。性能の設計の NFR3.1 の文言だけ古い（新規の Minor 参照）。

> R-02 Reviewer note: `onRequest` での認可、存在しないゲームも別のゲームも 403、判定の順は追記され、網羅試験にも反映された。ただし参加の要求の窓の検査を `onRequest` に置いた点が、本文の参加コードを要する手順と矛盾する（新規の Major 参照）。認可そのものの位置は解決済みで、残るのは参加の要求の位置のみ。

> R-03 Reviewer note: scalability-design.md の NFR4.2 が上流 NFR7.1 の（b）を Q2 の A で置き換えたと明記し、上限（約 10 分、24 時間以内）と掃除の試験を reliability-design.md に追加した。

> R-04 Reviewer note: 注入した時計（アプリケーション側）、ずれ 1 秒程度の許容、順序 (attempted_at, id) が NFR6.5 に明記された。

> R-05 Reviewer note: 無効な token の 3 つの場合の比較の対象（状態コード、本文、固定のヘッダ）が明記された。

> R-06 Reviewer note: 新しい 11 件を残す DELETE の SQL と `id bigserial` が記載された。

> R-07 Reviewer note: 2 つの整数の形のロックと専用の classid、U1 が行の占有であることから鍵の空間が交わらないことが記載された。

> R-08 Reviewer note: warn のログと alert の通知の書き分け、通知は Operation への引き継ぎが observability と reliability で一致している。

> R-09 Reviewer note: `inputtedRoleCount` の読み取り元（確定前の入力の保存済みの行の数）と 0 の場合が記載された。

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| (none listed for this stage) | Not run | 検証ツールの指定がないため実行していない。参照の確認は、上流の NFR6.4、NFR6.5、NFR7.1 と contract-summary.md の `/games/join` を読んで手で行った。 |

### Summary

前回の 9 件のうち、R-01 と R-03〜R-09 は解決した。R-02 の認可の位置も、一般の経路では解決した。残る重い矛盾は、参加コードが本文にあるのに窓の検査を `onRequest` に置いた点で、フックの位置を直せば実装できる。Major は 1 件、Critical は 0 件のため、READY とする。
