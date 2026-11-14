## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-13T05:35:20Z
**Iteration:** 2
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/security-requirements.md > NFR6.3 | CSV インジェクションを受け入れる根拠が成り立っていない。「進行役だけが取得できる」ことと「表示名の長さの制限（U1）」でリスクが小さいとしているが、攻撃者は表示名を自由に決められる参加者で、被害者は出力を表計算ソフトで開く進行役である。取得者が限られるほど、被害者は進行役に絞られるだけで、リスクは下がらない。表示名の上限は 40 文字（contract-summary.md の replacement と同じ上限）で、`=HYPERLINK(...)` のような式は 40 文字に収まる。軽減策の注意書きは「推奨」で、要件でも確かめ方でもない（NFR 設計に先送り）。残るリスクの欄にも「注意書きは NFR 設計で確定」とあり、誰も決めないまま受け入れた形になる | 受け入れの根拠を、実際の脅威（参加者が入力した表示名が進行役の表計算ソフトで式になる）に合わせて書き直す。注意書きは「出力ボタンの近くに必ず置く」要件にして、画面の試験で確かめる。BR23.3 の「値を変えない」を保つ前提で、追加の対策（例: 出力の画面に式として実行される恐れを示す、表示名の先頭文字の制限を U2 の入力検証で検討する）を採るか採らないかを、理由つきで明示して人の承認を得る | Resolved (reviewer) |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/traceability.json > NFR11 | NFR11 は requirements.md で「画面と出力の言語: 日本語のみ」だが、「出力」を画面の文言と読み替えて N/A にしている。U5 は CSV と JSON の出力を作る Unit なので、出力の言語は U5 自身の要件である。しかも読み替えの根拠は「コード生成の前に確認する」という未確認の仮定のまま成果物に残っている。列名（gameId、weeklyCostCents など）と役割の値が英語であることは Functional Design（BR23.2、BR23.5）で決まっているが、NFR11 との整合を人が判断した記録がない | NFR11 を N/A にせず、U5 の要件として扱う。「出力の列名と値は読み戻すための識別子であり、NFR11 の対象外とする」という解釈を、人の確認を得て記録するか、日本語の列名を併記する案と比較して決める。確認が取れるまで、この解釈を前提として確定済みの扱いにしない | Resolved (reviewer) |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/reliability-requirements.md > NFR2.4、NFR2.5（対 functional-design/entities.md の lastOperationAt 移行 21 行目、rules.md BR26.3） | NFR2.5 は移行で参加者の入力や確定の記録の時刻まで含めて埋めるとするが、entities.md は「createdAt と履歴の最後の occurredAt のうち遅い方」としており、食い違う。参加者の入力が履歴に残らないなら、entities.md の規則では移行直後に早すぎる自動終了が起きる（NFR2.5 自身が警告するリスク）。NFR2.4 も、BR26.3 の「古い順に上限まで選ぶ」では失敗が続くゲームが上限（100 件）を占めて後ろが処理されなくなるので、BR26.3 の変更が要る。どちらも Functional Design の成果物を直すべき点なのに、この工程の成果物にはその修正が必要だという記録（引き渡し事項）がない。実装者は 2 つの文書で異なる規則を読むことになる | functional-design の entities.md（移行の規則）と rules.md（BR26.3 の選び方）を NFR の記述に合わせて直すことを、引き渡し事項として明記する（または Functional Design を実際に直す）。NFR2.4 の方法は「失敗したゲームを次の選択で後ろに回す」など、確かめられる規則を NFR 設計までに一つに決める | Resolved (reviewer) |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/scalability-requirements.md > NFR4.1 | 「保持期間を短くした直後でも 1 日以内」は、対象が 3000 件のとき 1 日の処理能力（2400 件）を超えるので成り立たない（上限 100 件 × 24 周期 = 2400）。最悪の場合は約 30 時間かかる | 許容を「対象が 2400 件までなら 1 日以内。それを超える分は超えた件数に応じて延びる」と正確に書くか、1 回の上限を上げる | Resolved (reviewer) |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/security-requirements.md > NFR6.6 | 設定の検査は「意図せず多くのゲームを削除しないため」としているが、範囲の下限が 1 日なので、`RETENTION_DAYS=3`（30 の入力ミス）のような誤りは範囲内で通り、検査では防げない。守りは 1 回の上限（既定 100 件）だけで、残るリスクにも同じ記述がある | 起動時に有効な設定値をログに 1 回出す、既定より大きく短くした場合は警告を出す、を要件に足す。または検査の目的の記述を「範囲外の値を拒否する」に改め、誤った大量削除はバッチの上限と運用手順で抑える、と書く | Resolved (reviewer) |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/reliability-requirements.md > NFR5.2 | 停止時に待つ時間の上限に数値がなく、確かめる試験の判定基準がない（NFR2.3 の「一貫した読み取り」も、分離の水準が決まっていない。読み取りが 1 回のスナップショットなら、途中の削除で 403 ではなく 200 の完全な結果になるため、試験の期待値が分離の水準で変わる） | 待つ上限を秒で示す（例: コンテナの停止の猶予より短くする）。NFR2.3 は、使う分離の水準（または 1 つの問い合わせでの取得）を決め、試験の期待値を一つにする | Resolved (reviewer) |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/observability-requirements.md > NFR9.2 | 「直近 3 回が連続して失敗または skipped」で `error` を出す規則は、複数のインスタンスで動かすと、ロックを取れないほうのインスタンスで skipped が常に続き、通常の動作で誤った `error` が出る（NFR4.2 は複数のインスタンスを許す） | skipped の連続は `error` の対象から外す（または全インスタンスで何も処理されない場合だけ警告する）。失敗の連続だけを対象にするか、複数のインスタンスでの扱いを Operation に渡すと明記する | Resolved (reviewer) |
| R-08 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/reliability-requirements.md > NFR5.1 と NFR2.4 | NFR5.1 は「前の回の状態を持ち越さない」と書くが、修正で入れた NFR2.4（失敗したゲームの識別子を 1 周期メモリに持つ）と NFR9.2（連続の回数をメモリに持つ）は、前の回の状態を持ち越す。実装者がどちらに従うか迷う | NFR5.1 の文を「対象の判定は毎回データベースの状態から行う。持ち越してよいのは、失敗したゲームの除外（NFR2.4）と連続の回数（NFR9.2）だけ」のように直す | New |
| R-09 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/observability-requirements.md > NFR9.2 | 連続の判定から skipped を外したが、skipped の回が連続の回数を 0 に戻すのか、そのまま保つのか、`error` を 4 回目以降も毎回出すのかが書かれていない。また Q4 の A（人が承認）は「失敗または skipped」の連続と書いており、この変更は人が決めた文言と異なる。理由は NFR9.2 に書かれているが、ゲートで人が知らないまま通る恐れがある | skipped の回の数え方（保つ）と `error` を出す条件（3 回目に 1 回、または毎回）を一文で足す。Q4 の A からの変更点と理由を、承認ゲートの要約に明示する | New |
| R-10 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/security-requirements.md > NFR6.8（および rules.md の BR23.10） | 「前後の空白を取り除いた表示名の先頭が、タブ、復帰のもの」を拒否するとあるが、空白の除去がタブと復帰も取り除くなら、この 2 つは判定に現れず、試験も書けない。除去が U1 の既存の正規化と同じかどうかも書かれていない | 空白の除去の定義（取り除く文字）を U1 の表示名の正規化に合わせて明記する。タブと復帰を判定に残すなら、取り除く対象から外す。コード生成で試験の例を足す | New |

> R-01 Reviewer note: security-requirements.md の NFR6.3 は「値は元のまま」に限定され、対策は NFR6.8 に入口（422）と出口（注意書き）の二重で書かれた。rules.md に BR23.9 と BR23.10 が実在し、確かめ方に試験が書かれ、残るリスクと引き渡し事項（U1 の join と U3 の replace）も明記された。Q5 の A と一致する

> R-02 Reviewer note: performance-requirements.md に NFR11.1 と NFR11.2 が足され、traceability.json の NFR11 が OK になった。解釈は Q6 の A で人が確認済みで、BR23.9 が列名の日本語の説明を担う

> R-03 Reviewer note: NFR2.5 の移行（createdAt、履歴の最後の occurredAt、参加者の参加の時刻、週の記録の decidedAt の最大）が entities.md の制約と一致した。NFR2.4 の方法は「失敗したゲームを 1 周期選択から外す」の一つに決まり、rules.md の BR26.3 と一致する。引き渡し事項の表も足された

> R-04 Reviewer note: NFR4.1 は、2400 件以内なら 1 日以内、超える分は 1 周期 100 件ずつ延びると、計算（24 周期 × 100 件、3000 件で約 30 時間）が合う形で書かれた

> R-05 Reviewer note: NFR6.6 に、起動時の有効な設定値のログ、既定より短い設定の `warn`、運用手順書への案内が足され、確かめ方にも試験がある

> R-06 Reviewer note: NFR5.2 に待つ上限 10 秒と猶予との関係、NFR2.3 に `REPEATABLE READ` と期待値の 2 通りが書かれた

> R-07 Reviewer note: NFR9.2 は skipped を連続の対象から外し、試験（skipped が 3 回続いても `error` が出ない）も書かれた。ただし下の新しい所見 2 を参照

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| traceability.json の確認（読み取り） | NFR1〜NFR11 がすべて OK または N/A で、NFR6.8 と NFR11.1/NFR11.2 が追加されている | 取りこぼしなし。NFR10 の N/A は理由つき |
| NFR と BR の相互参照（読み取り） | BR23.9、BR23.10、BR26.3、NFR2.5 と entities.md の移行の規則が実在し、内容が一致した | 前回の食い違いは解消 |
| 検証ツール | stage 定義の検証ツールは実行していない（シェルを使わない依頼のため） | 読み取りによる突き合わせのみ |

### Summary

前回の 7 件はすべて、正しい場所に検証できる形で直っていて、Critical と Major の所見はない。新しく見つかったのは、NFR 間の文言の食い違いと数え方の曖昧さという Minor 3 件で、READY を妨げない。
