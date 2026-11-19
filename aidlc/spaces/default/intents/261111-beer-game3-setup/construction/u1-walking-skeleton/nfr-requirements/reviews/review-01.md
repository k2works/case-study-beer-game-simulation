## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-12T03:42:44Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/nfr-requirements/performance-requirements.md > NFR3.2 と「根拠と設計への影響」 | NFR3.2 は「週の確定後、画面への反映は 2 秒以内」とするが、同じ文書が、確定 500 ミリ秒（NFR3.3）に取り直しの周期 2 秒（Q2 の A）を足すと最大 2.5 秒になり、進行役以外の画面では 2 秒を超えうると認めている。つまり、決めた周期のままでは、要件の数値を満たせない設計が確定している。95 パーセンタイルかどうかも書かれていない。達成の判定を U6 に先送りしており、結論が実質的に「満たせないかもしれない」になっている | 次のどれかを選んで書く。(1) 周期を 1 秒にして 1 秒+0.5 秒で 2 秒に収める（負荷の見積りも直す）、(2) 最初から SSE を要件にする、(3) 反映の目標を「周期 + 確定の処理時間」に合わせた値（95 パーセンタイル）へ改め、requirements.md の NFR3 との差を明記して人の承認を得る。測定の対象（進行役の画面か、ほかの参加者の画面か）と百分位も書く | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/nfr-requirements/traceability.json > coverage の NFR5、NFR6、NFR7、および security-requirements.md > 「脅威の考慮」「コンプライアンス」、reliability-requirements.md > NFR5.1 | requirements.md では、NFR5（切断 30 分以内、復帰用 token 24 時間）、NFR6（無効なコードの試行は同じ接続元から 1 分あたり 10 回）、NFR7（保持 30 日、放置ゲームは 30 日で自動終了）の「仮の値」を、この NFR 要件の工程で確定するとしている（unit-of-work.md の U4 の項も同じ）。Q&A の前文も「仮の値は、この工程で U1 に当てはめます」と書く。しかし成果物は、有効期間・試行回数・保持期間を「U4 が足す」「U5 が足す」と先送りし、数値をどこにも確定していない。それでも traceability.json は NFR5、NFR6、NFR7 を OK とし、NFR5 の対象は NFR5.1（入力の保存）だけである。30 分・24 時間・毎分 10 回・30 日はどの要件行にも現れない | 確定した値（30 分、24 時間、毎分 10 回、30 日、放置 30 日）を、持ち主の Unit を明記した要件行として書く（U1 で実装しない分は「U4 で実装」のように）。それができないものは、traceability.json の status を OK から、理由付きの部分対応に改める。「U1 では token が失効しない」ことが NFR5 の値と矛盾しない理由も書く | New |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/nfr-requirements/performance-requirements.md > NFR3.4 と scalability-requirements.md > NFR4.1、「想定する負荷」 | 負荷の前提が食い違っている。NFR3.4 と「根拠」は 75 台（15 × 5）で毎秒およそ 38 回とするが、NFR4.1 と想定する負荷の表は 1 チーム最大およそ 17 台、全体およそ 255 台を想定している。255 台なら 2 秒周期で毎秒およそ 128 回で、約 3.4 倍になる。取り直しの応答 500 ミリ秒（95 パーセンタイル）を 75 台でだけ測ると、想定した最大の負荷を測らない。また 17 台は、参加者 16 人と進行役の計 17 で、観察者が含まれていない（表は観察者も含めると書く） | 測定の条件を一つに揃える。通常負荷（75 台）と最大想定（255 台以上）を分けて書き、それぞれに目標値を置く。取り直しの読み取りを支える仕組み（接続数、読み取りを 1 ゲームの直列処理から外すこと）を、毎秒 128 回以上で成り立つか確かめる。17 台の内訳を直す | New |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/nfr-requirements/security-requirements.md > NFR6.3 | Q3 の A は「鍵を変えるときは、再暗号化の手順を用意する」を決めたが、NFR6.3 に鍵の更新・再暗号化の要件がない。鍵がない、または復号に失敗したときの振る舞い（起動時に止めるのか、再表示だけ失敗させるのか）も書かれていない。また、参加コード・観察者用コードの照合用ハッシュ（BR1.4、entities.md の codeHash）が NFR6.3 から読み取れず、8 文字の英数字を鍵なしの SHA-256 で保存すると、DB の漏えいでオフラインで総当りされ、暗号化の意味が薄れる | 鍵の更新と再暗号化の手順、鍵の欠落時の振る舞いを要件にする。照合用ハッシュの方式（鍵付き HMAC を使うかなど）を書き、脅威の表の「データベースの漏えい」の記述を、参加コードについて正しい内容に直す | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/nfr-requirements/security-requirements.md > NFR6.5、NFR6.6、脅威の考慮 | 注入と転送の面で、U1 の範囲に入るものが書かれていない。表示名は他の参加者の画面に出る唯一の利用者入力だが、長さの上限と、出力時のエスケープ（スクリプト注入の防止）の要件がない。ブラウザ側の token の保管場所（localStorage か Cookie か）による盗用の面、CORS、セキュリティヘッダ（CSP、HSTS）も書かれていない。NFR6.6 の「確かめ方」は Authorization ヘッダを使うことの確認だけで、HTTPS だけを許すことの検査になっていない | 表示名の長さ・文字種と出力のエスケープを要件にして試験する。token の保管場所、CORS の方針、CSP と HSTS の要否を決めて書く。NFR6.6 の確かめ方に、HTTP を拒否または HTTPS へ転送する検査を足す | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/nfr-requirements/reliability-requirements.md > 障害の扱い、および scalability-requirements.md > NFR4.2 | ゲーム単位の直列処理の「順番待ちの時間切れ」（BR4.6 の 503）の待ち時間の上限に数値がない。NFR3.1 の 95 パーセンタイル 1 秒と、時間切れの値の関係が測れない。直列処理を「データベースの仕組みで行う」とあるが、アプリケーションが複数になっても成り立つ選択（行ロック、アドバイザリロックなど）と、待ちのあいだ接続を占有する影響が書かれていない | 順番待ちの時間切れの値（ミリ秒）を要件に置く。直列処理の方式の候補と接続数への影響を、NFR Design に引き継ぐ事項として書く | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| traceability.json の読み取り | NFR1〜NFR11 が上流 ID に全部あり、OK の対象 ID（NFR1.1〜NFR7.1）は 6 つの文書に実在する。NFR3.5、NFR3.6 は observability-requirements.md にある。N/A の NFR8〜NFR11 には理由がある | ID の網羅と実在は成立している。ただし NFR5、NFR6、NFR7 の OK は、仮の値が確定していないので内容として不十分（2 番目の指摘） |
| 技術スタックの版 | 「候補の版」「npm や公式サイトでの再確認はまだしていない」と明記されている | 未確認の候補として正しく書かれている。問題なし |
| 算術の確認 | 75 ÷ 2 = 37.5 で、毎秒およそ 38 回は正しい。255 ÷ 2 ≒ 128 回が成果物に出てこない。確定 500 ミリ秒 + 周期 2 秒 = 2.5 秒は正しく、文書自身が認めている | 計算は正しいが、結論が NFR3.2 を満たしていない（1 番目と 3 番目の指摘） |

### Summary

ID の網羅、機能設計（BR1.4、BR4.6、BR5.9）との整合、技術スタックの版の書き方、観測性の範囲は概ね妥当です。ただし、NFR3.2 は決めた周期のままでは数値を満たせず、NFR5、NFR6、NFR7 の仮の値はこの工程で確定されないまま OK と記録され、負荷の前提が 75 台と 255 台で食い違っています。この 3 点を直してから READY にできます。
