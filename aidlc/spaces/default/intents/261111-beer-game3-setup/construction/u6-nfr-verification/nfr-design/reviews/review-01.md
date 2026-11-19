## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-13T13:00:26Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-design/performance-design.md > 測定の設計 > 仮想の利用者 | 取り直しの周期を「遅れた分は詰めずに 1 回飛ばす」としているため、サーバーが遅くなるほど取り直しの回数が減り、遅い応答の標本も減る。理由欄の「負荷が減って見えるのを避ける」と逆の挙動で、95 パーセンタイルが実際より良く出る（coordinated omission）。失敗・タイムアウトした要求や、新しい週が一向に現れなかった画面を標本に数えるかも未定義で、生き残った標本だけで合否が決まる。NFR4.2 の最大想定区間（1 秒以内）の判定が最も影響を受ける | 周期の遅れで飛ばした取り直しも、予定時刻から数えた遅れの標本として記録するか、飛ばした回数を別に数えて閾値（上限）を設ける。失敗・タイムアウト・反映が観測できなかった場合は、上限値の標本または別の失敗件数として数え、合否に反映することを決める。理由欄の記述も実際の挙動に合わせて直す | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-design/performance-design.md > 週確定後の画面反映の測り方（Q1 の A）、logical-components.md > render-latency | Q1 の A（実 Chromium 1 チーム 5 画面）が、動かし方の契約として決まっていない。(1) そのチームの 4 役割の入力と週の確定を誰がいつ行うか（ブラウザの操作か、SeededPlan の HTTP か）が書かれていない。(2) ブラウザ側の 40 件の標本を、別プロセスの Playwright から Recorder と要約へ返す手段が未定。(3) 40 件の判定を「補助」とするが、超えたときに verdict を fail にするのか記録のみなのかが性能の予算の表にも要約の `thresholds` にもない。(4) 同じ文書で「単調時計で測る」としながら、この測定だけ `Date.now()`（壁時計）を使う。(5) 15 チームのうち 1 チームを実ブラウザに置くため、仮想の利用者は 14 チーム（70 画面）になり、NFR3.1 の確定の標本数も減るが、反映されていない | render-latency の起動・同期・結果の返し方（例: 標準出力の JSON か結果ファイル）と、そのチームの入力を駆動する担当を設計に書く。ブラウザ側の 95 パーセンタイルが閾値を超えたときの verdict（fail か記録のみか）を決め、`thresholds` に載せる。時計の扱いを統一するか、壁時計を使う理由と許容誤差を書く。仮想のチーム数を 14 とした場合の標本数を数え直す | New |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-design/logical-components.md > CI のジョブの設計 > 既知の前提 | 夜間の定期実行と手動実行は、ワークフローが既定の branch（`main`）にある場合にしか動かない。これは現在の GitHub の既知の挙動で、Code Generation で確かめる事柄ではない。一方、NFR3.1〜NFR3.3・NFR4.2 の合否は 10 分間の本試験だけが決め、要件は `develop` を `main` へ merge する前にも手動で実行することを求めている。`beer-game3.yml` がまだ `main` にない最初のリリース前は、この条件を CI で満たせない。代わりの「手元での本試験」は、成果物の 30 日保存、要約の `revision`、実行環境の比較（NFR4.4）の扱いが未設計で、閾値を満たしたという証拠として足りるかが決まっていない | 最初のリリースの前に本試験の証拠を得る手順を設計する。例: `main` に最小のワークフローを先に入れて `workflow_dispatch` を有効にする、または手元の実行の要約を決まった場所に記録してリリース前の確認の条件にする。どちらを採るか、実行環境の記録をどう扱うかを書く。既知の挙動は設計の前提として確定させ、確認事項に残さない | New |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-design/performance-design.md > 週確定後の画面反映の測り方 > 判定 | 仮想の利用者の反映の標本数を「約 2400 件」としているが、15 チーム × 10 週 × ほかの 4 画面 = 600 件（NFR3.5 の要件にある「約 600 件」と同じ）、実ブラウザのチームを除くと 560 件になる。数値が 4 倍に誤っており、主の判定の統計の強さを過大に述べている | 標本数を 560〜600 件に直し、判定の説明（40 件と比べた強さ）を合わせる | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-design/scalability-design.md > 規模を表す設定、本試験の時間配置 | 最大想定で追加する 195 台の取り直し専用画面が、いつ・どの資格情報で参加するかが書かれていない。時間配置の 0〜10 秒には 75 台分の参加だけがあり、610 秒時点で参加させると、要件（NFR4.2「書き込みの頻度は通常負荷と同じ」）に反する参加の書き込みが区間の頭に集中する | 追加画面の参加と資格情報の用意を、立ち上げ期間（集計から除く時間）に済ませるか、区間の頭の書き込みを許容して記録するかを決め、時間配置の表に載せる | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-design/traceability.json > NFR8.1、NFR8.2 | NFR8.1 は 6 つの画面（作成、参加、ロビー、プレイ、進行管理、結果）と、結果の表示・出力の開始までのキーボードだけの通しを求めるが、設計文書は「キーボードの通し試験を 4 ブラウザで」と言うだけで、通しの手順も、a11y で検査する画面と状態（エラー、一時停止、終了、結果、出力の注意書き）の一覧も示していない。トレーサビリティの記述（6 画面）に対応する本文がない | 通しの工程と、画面 × 状態の検査の対象の一覧を、performance-design.md か logical-components.md に書く | New |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-design/security-design.md > CI の定義の検査、observability-design.md > 成果物と保持 | CI の定義の検査は、トレースと画像の 7 日と本試験の要約の 30 日だけを確かめる。プルリクエストごとの短い負荷試験の要約（7 日）と、本試験の要約を成功時にも保存する条件（`if: always()` 相当）が検査の対象から漏れている | 検査の項目に、短い試験の要約の保持日数と、本試験の要約の保存条件を足す | New |
| R-08 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-design/security-design.md > 脅威と防御の対応（生成した資格情報） | 実ブラウザの測定では、トレースと画像を取らないだけで、Playwright 自身の失敗時の出力（アサーションのエラー文、失敗時のページの要約ファイル、レポーターの出力）が LoadRunner の標準出力や成果物に流れる経路が塞がれていない。画面に出ている参加コードや token が書かれる可能性がある（NFR6.3 は「スクリプトが書く出力」に書かないことを要件とする） | 子プロセスの出力は LoadRunner が受けて許可リストで通すか、レポーターと失敗時の追加の成果物を無効にし、その設定を CI の定義の検査と同じく試験で確かめることを決める | New |
| R-09 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-design/security-design.md > 接続先の検査（TargetGuard） | 検査の対象がアプリケーションの URL とデータベースの接続先のホスト名だけで、接続文字列の `host=` パラメーターや環境変数（`PGHOST` など）による上書きを考慮していない。また、「接続先は環境変数で明示し、既定を持たない」（防御 1）と「スクリプトが自分で localhost に起動するのが標準」（防御 2）が同じ表で並び、既定の有無が読み取れない | 検査はスクリプトが組み立てた最終の接続設定に対して行うこと、外部の `PG*` の環境変数を子プロセスに渡さないことを書き、既定の有無を 1 つに整理する | New |
| R-10 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-design/logical-components.md > CI のジョブの設計（load-main、load-smoke） | 手動実行で検査する branch を指定する入力（要件 NFR3.5）が設計になく、`develop` の明示取得だけが書かれている。また、プルリクエストの必須チェックである `load-smoke` が、共有実行機の揺れによる「無効」（終了コード 2）で失敗した場合の扱いが、再実行禁止の方針と合わせて決まっていない | 手動実行の branch 入力を設計に足す。短い試験の「無効」の扱い（例: 原因を記録して修正するまで統合を止める）を信頼性の設計に書く | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| traceability.json の ID の突き合わせ（手作業） | PASS: U6 の要件の NFR1.1〜NFR11.2 の 34 件がすべて掲載され、対象の文書と節も存在する | 網羅は OK。ただし NFR3.2、NFR8.1、NFR8.2 は、対象の文書の記述が要件を満たすのに足りていない（上の Major と Minor） |

### Summary

要件の網羅と文書間の参照、終了コード（0、1、2）、保持日数は概ね整合しているが、測定の統計の健全性（周期を飛ばす設計と失敗標本の扱い）、Q1 の A の実ブラウザ測定の動かし方、最初のリリース前に本試験の証拠を得る手順の 3 点は、実装者が推測で補う必要がある。これらを直すまで READY としない。
