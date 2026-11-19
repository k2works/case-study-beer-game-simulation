## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-13T04:58:48Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/functional-design/rules.md > BR26.3 と BR26.4 | 自動終了も削除も、古い順に上限まで選び、失敗したゲームは「次の周期でやり直す」としている。失敗が続くゲーム（削除の途中で必ず失敗する、など）が batchLimit 件以上あると、毎回それらが先頭を占め、より新しい期限切れのゲームが永久に処理されない。失敗が続くことを見つける手段（連続の失敗の数、ログの警告の基準）も定めていない | 失敗したゲームが先頭を塞がない順序の規則を決める（たとえば、失敗したゲームを後ろに回す、1 回の処理で失敗に数えた件を上限の消費から除く、など）。または、同じゲームが連続して失敗した回数をログの警告の基準にし、運用で気づけるようにする。いずれかを BR26.3 または BR26.4 に書く | New |
| R-02 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/functional-design/entities.md > Game.lastOperationAt の constraints と rules.md > BR25.2 | BR25.2 は「終了」を lastOperationAt を更新する操作に挙げているが、entities.md は「終了したゲームでは更新しない」としている。終了の操作そのものの保存で更新するのか、しないのかが読み分けられない | 終了の操作の保存では lastOperationAt を更新するか否かを 1 つに決め、両方の文書をそろえる | New |
| R-03 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/functional-design/functional-spec.md > W4 手順 1 | 自動終了の対象を「足した時刻を過ぎた」と書いているが、BR25.1、BR25.4 は「以降」（期限ちょうどを含む）としている。境界の値の扱いが文書間で違う | W4 の文言を「以降」に直し、期限ちょうどの時刻を含むことを明記する | New |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/functional-design/functional-spec.md > 結果の取得の可否の表 | 表は観察者を「403（権限なし）」、資格情報なしを「403（無効）」と書き分けているが、BR21.2、BR21.1 は区別できない同じ 403 の本文で返すとしている。表を読むと、本文が違うように見える | 表の括弧書きは画面が出す文言であって応答の本文の違いではない、と注記する。または括弧書きを消す | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/functional-design/rules.md > BR21.5 | 結果の取得は「占有せず 1 回の読み取り」としているが、削除は別の保存で同時に動く。ゲームの行、週の記録を別々の問い合わせで読むと、削除と重なったときに、ゲームはあるが週が 0 件の空の結果を 200 で返す恐れがある。取得が一貫した 1 つの時点を読むことを定めていない | 結果と出力の読み取りが、1 つの一貫した時点（1 つの読み取り用の保存）で行われること、削除と重なったときは存在しないゲームと同じ 403 になることを書く | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/functional-design/rules.md > BR23.3 | 先頭が =、+、-、@ の表示名を無害にせず元のまま出す（Q6 の A）。表示名は参加者が自由に決められるため、進行役が表計算ソフトで開くと式が実行される恐れが残る。利用者が選んだ判断だが、残るリスクが functional-spec.md の未確定の事項に載っていない | 受け入れた残りのリスク（CSV インジェクション）を未確定の事項または規則の中に記録し、後続の工程（NFR、セキュリティ）で確かめられるようにする。JSON で元の値を得られることも添える | New |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/functional-design/entities.md > Game.lastOperationAt の constraints（既存の行の移行） | 既存の行を createdAt と履歴の最後の occurredAt の遅い方で埋めるとしている。参加、開始、参加者の入力は履歴の 7 種類に含まれないため、活発に使われているゲームでも履歴が古く、移行の直後に早すぎる自動終了の対象になる恐れがある | 移行の埋め方に、週の記録の入力の時刻（decidedAt など）も候補に加える。または、移行の時刻で埋めて期間を数え直す、と決める | New |
| R-08 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u5-results-retention/functional-design/rules.md > BR26.2 | アドバイザリロックを「待たずに取り、接続が切れたら解放される」としている。この性質は接続ごとのロックでのみ成り立つため、1 回の処理の間、同じ接続を保持し続ける必要がある。ゲームごとの短い保存は別の接続で動くことも、規則に書かれていない | 1 回の処理の間はロック用の接続を保持し、ゲームごとの保存はそれとは別の接続で行うこと、保持できないときは skipped とすることを書く。または未確定の事項のインフラの設計の工程に明記する | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| traceability.json の手作業の突き合わせ | PASS | AC4.1.1〜4、AC4.2.1〜3、AC5.1.1〜3 のすべてが実在する BR を指している。BR21.1〜BR26.6 は、coverage か reverse のどちらかに載っており、孤立した規則はない |
| 契約との突き合わせ（contract-summary.md の C1、C3、C5） | PASS | results、export の入口、C5 の delete、query の形と、U5 の記述は矛盾しない。retention_policies を作らず last_operation_at を足す変更は entities、rules、functional-spec で一貫している。U3 の autoEnd（apps/beer-game3/src/server/session/game-session.ts）は現在 期限の再検査を持たず、設計の「足す」という主張と合う |
| 質問への回答の反映（Q1〜Q9 すべて A） | PASS | Q1 表の併記は BR22.4、Q2 は BR21.2、Q3 は BR24.1、Q4 は BR24.2、Q5 は BR25.1、Q6 は BR23.3、Q7 は BR23.4、BR23.5、Q8 は BR24.3、BR24.6、Q9 は BR26.1、BR26.2 に反映されている |

### Summary

U5 の機能設計は、受入条件を網羅し、3 つの文書の間で数値、状態、応答の対応がおおむね一貫していて、契約の変更も矛盾なく整理されている。唯一の Major は、失敗が続くゲームが古い順の上限つきの選択を塞ぐ恐れで、順序の規則を 1 つ足せば直せる。そのほかは文書間の文言のずれと、残るリスクの記録で、実装の妨げにはならない。
