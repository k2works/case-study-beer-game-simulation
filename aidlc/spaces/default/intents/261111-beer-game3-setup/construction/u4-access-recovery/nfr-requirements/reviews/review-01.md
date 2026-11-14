## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-13T01:56:39Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-requirements/performance-requirements.md > NFR3.4、NFR3.5。scalability-requirements.md > NFR4.2、NFR4.4。security-requirements.md > NFR6.4、NFR6.10。traceability.json > coverage の target | U4 は、U1 が別の意味で持つ番号を同じ番号で定義し直している。U1 の NFR3.4 は取り直しの応答目標、NFR3.5 は要求ごとの識別子と構造化ログ、NFR4.2 はゲーム単位の直列処理、NFR4.4 は読み取りが書き込みを待たないこと、NFR6.4 はログに資格情報を出さないこと、NFR6.10 は localStorage・CSP・HSTS である。U4 の NFR3.4 は再起動直後の初回取得、NFR3.5 は切断中の 1 秒周期の再試行、NFR4.2 は試行の窓の大きさ、NFR4.4 は lastUsedAt の書き込み、NFR6.4 は無効な token の拒否、NFR6.10 は観察者用コードの保存である。同じ文書群の中で「U1 の NFR4.2」「U1 の NFR4.4」「U1 の NFR6.4」「U1 の NFR6.10」「U1 の NFR3.5」を参照しており、接頭辞なしの番号がどちらを指すか決められない。observability-requirements.md の「U4 は、これらの番号を別の意味で使わない」とも矛盾する。traceability.json の target も、U1 の同じ番号と区別できない | U1 から引き継ぐ番号は常に「U1 の」を付けて参照し、U4 で新しく定義する要件には U1 と衝突しない番号（例: NFR3.8 以降、NFR4.7 以降、NFR6.12 以降）を割り当てるか、全要件の ID を `U4-NFR3.4` のように Unit 接頭辞付きにする。traceability.json の target も同じ表記に揃え、observability-requirements.md の「別の意味で使わない」の記述を事実に合わせて直す | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-requirements/security-requirements.md > NFR6.5、NFR6.6、脅威の考慮 | 窓の単位である「接続元」が、IPv6 でどの粒度かが定義されていない。IPv6 の利用者は 1 つの /64 から多数のアドレスを使えるため、アドレス単位で数えると 10 回の制限を回避できる。逆に、転送元ヘッダの形式（複数アドレス、ポート付き、IPv4 射影アドレス）の正規化も書かれていない。偽ヘッダ対策は段数だけで、窓のキーが一意に決まることを測定できる要件がない | 接続元のキーを定義する（例: IPv4 は完全なアドレス、IPv6 は /64 に丸める。IPv4 射影アドレスは IPv4 に正規化）。そのキーで境界の試験（同じ /64 の別アドレスから 11 回目が 429）を確かめることを NFR6.5 または NFR6.6 に加える | New |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-requirements/security-requirements.md > NFR7.1、コンプライアンス。scalability-requirements.md > NFR4.2、拡張の方針。observability-requirements.md > NFR9.1、NFR9.4 | IP アドレスの保持が測定できる要件になっていない。(1) NFR7.1 は「試行が止まったあとに残る行の削除は U5 の対象に加える」と他の Unit に義務を送るが、共有契約の unit-of-work.md の U5 は「保持期間を過ぎたゲームを削除し、放置されたゲームを自動終了する」だけで、ゲームに結びつかない窓の行は範囲に無い。保持の長さの数値もない。(2) 窓の上限は「1 つの接続元につき 11 件」だけで、接続元の数は無制限（IPv6 の回転で表が増え続ける）。メモリ案を「接続元の数の上限が要る」として却下した理由が、PostgreSQL 案にもそのまま当てはまる。(3) NFR7.1 は IP を「レート制限の判定のためだけに使う」とするが、NFR6.9、NFR9.1、NFR9.4 は構造化ログに接続元を出し、その保持期間は未定義で、NFR7.1 の主張と矛盾する | 窓の行の最大保持期間を数値で決める（例: 最後の試行から N 時間、または日数）。その削除を U5 の責務として unit-of-work.md の U5 に記録するか、U4 自身が行う。表全体の上限（行数または接続元数）、またはその超過時の挙動を定める。ログに残す接続元の保持期間と、NFR7.1 の「判定のためだけ」の記述を整合させる | New |
| R-04 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-requirements/security-requirements.md > NFR6.2、脅威の考慮（観察者の合計から逆算） | 観察者の合計から役割別の値を逆算できないことが、合否の基準を持たない。確かめ方が「レビューで確かめる」「合計から内訳を推測できる入力の組合せを試す試験」で、どの入力の範囲を、何を推測できたら失敗とするかが書かれていない。機能設計はこの確認を NFR の工程に送っているが、ここでは判定できる要件にならず、そのまま後ろに送られている | 逆算の合格基準を決める。例: 観察者の応答の項目の固定リストと、「1 週の合計の差分から単独の役割の値が確定する入力はあってはならない」といった反例探索の条件（入力範囲、週数）、または推測可能な場合に項目を削る規則を、試験の条件として書く | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-requirements/security-requirements.md > NFR6.4 | 「応答時間の違いで期限切れか、失効か、存在しないかを明かさない」は測定できない。確かめ方は応答の内容の一致だけで、時間の差の許容値と測り方がない。不明な token と期限切れの token は、検索の経路が異なる | 応答時間の差の許容値と測定方法を書く（例: 3 つの場合の中央値の差が N ミリ秒以内）。または時間の隠蔽は要件にせず、内容の一致だけを要件にする | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-requirements/tech-stack-decisions.md > 決定（PostgreSQL）、方針。reliability-requirements.md > NFR2.3 | 窓の原子的な検査と追加の方法として「1 文での条件付きの追加」を候補に挙げているが、窓が空のときは行ロックが掛からず、READ COMMITTED の並行した追加では通れる件数が 10 を超えうる。接続元ごとの排他の待ち時間の上限と、超えたときの応答（503 か）も、障害の扱いの表に無い | 要件として「窓が空でも排他が効く（アドバイザリロックまたは直列化できる分離レベル）」を明記する。排他の待ち時間の上限と、超過時に 503 `unavailable` とすることを NFR2.2 または障害の扱いに足す | New |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-requirements/performance-requirements.md > NFR3.1、NFR3.3。reliability-requirements.md > NFR5.2 | 数値の書き方が揃っていない。NFR3.1 の最大想定の「1 秒以内」にパーセンタイルがない（U1 は 95 パーセンタイル）。NFR3.3 の「50 ミリ秒」は何と何の差かが不明。lastUsedAt を 1 分に 1 回しか書かないので、24 時間の期限は実際には最大 1 分短く切れるが、境界の試験にこの許容が書かれていない。アプリが複数のときに「1 分に 1 回」を保つ方法（条件付きの更新）も書かれていない | NFR3.1 に 95 パーセンタイルを明記する。NFR3.3 の 50 ミリ秒を「延長の書き込みを含む場合と含まない場合の応答時間の差」と定義する。NFR5.2 と NFR6.4 の 24 時間の境界に 1 分の許容を書く。複数のアプリでも書き込みが 1 分に 1 回になる条件（最後の書き込みの時刻を条件にした更新）を NFR4.4 に足す | New |
| R-08 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-requirements/traceability.json > NFR8。security-requirements.md > NFR6.9、observability-requirements.md > NFR9.1 | NFR8 を N/A として U6 に送っているが、U4 は観察画面、観察者の入口、切断中の表示を新しく作る。U4 自身の画面の検査項目（キーボード操作、色だけに頼らない表示）を測定できる要件にしていないため、「各 Unit も自分の画面について同じ検査を通す」（unit-of-work.md の U6）の受け皿がない。また、`invalid_code` を無効な参加コードの種類と定義しているが、無効な進行役用コード・観察者用コードの拒否をどの種類で出すかが NFR6.9 と NFR9.1 で食い違いうる | NFR8 は N/A でなく、U4 の画面に限った要件（キーボードだけで操作できる、状態を色だけで示さない）を 1 行置き、全体の検査を U6 に残す。無効な進行役用コード・観察者用コードのログの種類を明記する | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| traceability.json の目視突合（requirements.md の NFR1〜NFR11） | 11 件すべて列挙。OK の target（NFR1.1、2.1〜2.3、3.1〜3.5、4.1〜4.6、5.1〜5.4、6.1〜6.10、7.1、9.1〜9.5）は成果物に実在する。N/A は NFR8、NFR10、NFR11 | 網羅は成立している。NFR10 と NFR11 の N/A は妥当。NFR8 の N/A は弱い（Minor）。番号が U1 と衝突している（Major） |
| 数値の突合 | 105 = 75 + 30、330 = 270 + 60、4.5 = 270 ÷ 60、1.3 = 75 ÷ 60 は計算が合う | 数値の矛盾はない。token の数に端末の数（観察者・進行役を含む）を使っていて保守的であり、欠陥ではない |
| 他 Unit の番号の突合（U1 の performance、scalability、security、observability の 1 件ずつの所有ファイル） | U1 の NFR3.4、3.5、4.2、4.4、6.4、6.10 は U4 と別の意味。「U1 の NFR6.11」「U1 の NFR3.7」の参照は一致 | 番号の再利用が確認された（Major） |

### Summary

要件の網羅と数値の計算は合っているが、U1 と同じ番号を別の意味で使っている点、IPv6 での接続元の粒度が無い点、IP の保持と削除の責務が測定できず共有契約にも無い点、観察者の逆算の合格基準が無い点の 4 件の Major があり、NOT-READY とする。
