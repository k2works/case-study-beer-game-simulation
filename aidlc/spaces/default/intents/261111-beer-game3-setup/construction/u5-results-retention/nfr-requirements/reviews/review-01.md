## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-13T05:23:01Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/security-requirements.md > NFR6.3 | CSV インジェクションを受け入れる根拠が成り立っていない。「進行役だけが取得できる」ことと「表示名の長さの制限（U1）」でリスクが小さいとしているが、攻撃者は表示名を自由に決められる参加者で、被害者は出力を表計算ソフトで開く進行役である。取得者が限られるほど、被害者は進行役に絞られるだけで、リスクは下がらない。表示名の上限は 40 文字（contract-summary.md の replacement と同じ上限）で、`=HYPERLINK(...)` のような式は 40 文字に収まる。軽減策の注意書きは「推奨」で、要件でも確かめ方でもない（NFR 設計に先送り）。残るリスクの欄にも「注意書きは NFR 設計で確定」とあり、誰も決めないまま受け入れた形になる | 受け入れの根拠を、実際の脅威（参加者が入力した表示名が進行役の表計算ソフトで式になる）に合わせて書き直す。注意書きは「出力ボタンの近くに必ず置く」要件にして、画面の試験で確かめる。BR23.3 の「値を変えない」を保つ前提で、追加の対策（例: 出力の画面に式として実行される恐れを示す、表示名の先頭文字の制限を U2 の入力検証で検討する）を採るか採らないかを、理由つきで明示して人の承認を得る | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/traceability.json > NFR11 | NFR11 は requirements.md で「画面と出力の言語: 日本語のみ」だが、「出力」を画面の文言と読み替えて N/A にしている。U5 は CSV と JSON の出力を作る Unit なので、出力の言語は U5 自身の要件である。しかも読み替えの根拠は「コード生成の前に確認する」という未確認の仮定のまま成果物に残っている。列名（gameId、weeklyCostCents など）と役割の値が英語であることは Functional Design（BR23.2、BR23.5）で決まっているが、NFR11 との整合を人が判断した記録がない | NFR11 を N/A にせず、U5 の要件として扱う。「出力の列名と値は読み戻すための識別子であり、NFR11 の対象外とする」という解釈を、人の確認を得て記録するか、日本語の列名を併記する案と比較して決める。確認が取れるまで、この解釈を前提として確定済みの扱いにしない | New |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/reliability-requirements.md > NFR2.4、NFR2.5（対 functional-design/entities.md の lastOperationAt 移行 21 行目、rules.md BR26.3） | NFR2.5 は移行で参加者の入力や確定の記録の時刻まで含めて埋めるとするが、entities.md は「createdAt と履歴の最後の occurredAt のうち遅い方」としており、食い違う。参加者の入力が履歴に残らないなら、entities.md の規則では移行直後に早すぎる自動終了が起きる（NFR2.5 自身が警告するリスク）。NFR2.4 も、BR26.3 の「古い順に上限まで選ぶ」では失敗が続くゲームが上限（100 件）を占めて後ろが処理されなくなるので、BR26.3 の変更が要る。どちらも Functional Design の成果物を直すべき点なのに、この工程の成果物にはその修正が必要だという記録（引き渡し事項）がない。実装者は 2 つの文書で異なる規則を読むことになる | functional-design の entities.md（移行の規則）と rules.md（BR26.3 の選び方）を NFR の記述に合わせて直すことを、引き渡し事項として明記する（または Functional Design を実際に直す）。NFR2.4 の方法は「失敗したゲームを次の選択で後ろに回す」など、確かめられる規則を NFR 設計までに一つに決める | New |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/scalability-requirements.md > NFR4.1 | 「保持期間を短くした直後でも 1 日以内」は、対象が 3000 件のとき 1 日の処理能力（2400 件）を超えるので成り立たない（上限 100 件 × 24 周期 = 2400）。最悪の場合は約 30 時間かかる | 許容を「対象が 2400 件までなら 1 日以内。それを超える分は超えた件数に応じて延びる」と正確に書くか、1 回の上限を上げる | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/security-requirements.md > NFR6.6 | 設定の検査は「意図せず多くのゲームを削除しないため」としているが、範囲の下限が 1 日なので、`RETENTION_DAYS=3`（30 の入力ミス）のような誤りは範囲内で通り、検査では防げない。守りは 1 回の上限（既定 100 件）だけで、残るリスクにも同じ記述がある | 起動時に有効な設定値をログに 1 回出す、既定より大きく短くした場合は警告を出す、を要件に足す。または検査の目的の記述を「範囲外の値を拒否する」に改め、誤った大量削除はバッチの上限と運用手順で抑える、と書く | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/reliability-requirements.md > NFR5.2 | 停止時に待つ時間の上限に数値がなく、確かめる試験の判定基準がない（NFR2.3 の「一貫した読み取り」も、分離の水準が決まっていない。読み取りが 1 回のスナップショットなら、途中の削除で 403 ではなく 200 の完全な結果になるため、試験の期待値が分離の水準で変わる） | 待つ上限を秒で示す（例: コンテナの停止の猶予より短くする）。NFR2.3 は、使う分離の水準（または 1 つの問い合わせでの取得）を決め、試験の期待値を一つにする | New |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/nfr-requirements/observability-requirements.md > NFR9.2 | 「直近 3 回が連続して失敗または skipped」で `error` を出す規則は、複数のインスタンスで動かすと、ロックを取れないほうのインスタンスで skipped が常に続き、通常の動作で誤った `error` が出る（NFR4.2 は複数のインスタンスを許す） | skipped の連続は `error` の対象から外す（または全インスタンスで何も処理されない場合だけ警告する）。失敗の連続だけを対象にするか、複数のインスタンスでの扱いを Operation に渡すと明記する | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| traceability.json の読み取り | NFR1〜NFR9 は OK、NFR10 と NFR11 は N/A。各 NFRx.y は成果物に実在し、要件の本文は数値と確かめ方を持つ | NFR11 の N/A は理由が未確認の読み替えに基づく（上の Major）。ほかの網羅に欠けはない |
| 数値の突き合わせ（rules.md、entities.md、functional-spec.md） | 既定 30 日、30 日、60 分、100 件と範囲（1〜3650、1〜1440、1〜1000）は一致。2400 件は 100 × 24 で一致 | 数値は整合。NFR4.1 の「1 日以内」の許容だけ最悪の場合に成り立たない（Minor） |
| 検証ツールの実行 | 実行していない（sensors は engine が別に確かめる） | 所見は成果物の読み取りに基づく |

### Summary

NFR1〜NFR9 の網羅と数値の整合は取れており、技術スタックも U1 の決定から増えていない。ただし、CSV インジェクションの受け入れ根拠が脅威の向きと逆になっていること、NFR11 の「出力」を未確認のまま読み替えて N/A にしていること、NFR2.4 と NFR2.5 が Functional Design の成果物と食い違うのにその修正が記録されていないことの 3 点が Major で、実装者が推測せずに作れる状態に至っていないため NOT-READY とする。
