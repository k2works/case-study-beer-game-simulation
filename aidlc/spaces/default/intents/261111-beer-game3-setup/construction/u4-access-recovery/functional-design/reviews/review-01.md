## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-13T01:22:51Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/functional-design/rules.md > BR16.2 and functional-spec.md > W2 手順 3 | BR16.2 は「顧客需要の取得要求」を 403 で拒否するとしているが、契約 C1 に顧客需要を取得する経路はなく、「契約への反映」にも新しい経路は載っていない。需要は小売店の投影に含まれるだけなので、AC2.1.2 の「拒否される」が、どの要求への 403 なのか決まらない。実装者は、経路を足すか、投影から省くだけにするかを推測することになる。 | 需要が小売店の状態投影の一部なのか、独立した経路なのかを決める。独立した経路なら、その経路を C1 への追加として「契約への反映」に書く。投影だけなら、BR16.2 を「小売店以外の投影に需要の項目がない」という規則に直し、AC2.1.2 をどの要求で検証するかを書く。 | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/functional-design/rules.md > BR18.2 と BR18.1 | 11 回目の判定が矛盾している。「直近 60 秒の無効な試行が 10 回を超えている（11 回目の試行）」と書かれているが、11 回目の到着時に窓にあるのは 10 回で、超えてはいない。数えてから判定するのか、判定してから数えるのかが決まっていない。「有効なコードでも拒否中は参加できない」ので、コードの有効性の検査より前に窓を調べる必要がある。しかし BR18.1 は「無効なとき」だけ窓に加える。11 回目が無効な試行なら 403 なのか 429 なのかも書かれていない。AC5.4.2 の「11 回目で拒否」と NFR6 の「1 分あたり 10 回まで」は、実装によって 10 回目と 11 回目のどちらにも読める。 | 判定の順序を 1 つに決める。たとえば「窓に既に 10 回以上あれば、コードの有効性を見る前に 429 を返す。そうでなければコードを検証し、無効なら窓に加えて 403 を返す」とする。境界値の例（10 回目は 403、11 回目は 429、有効なコードの 11 回目も 429）を Given/When/Then で rules.md に書く。 | New |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/functional-design/rules.md > BR18.2、BR18.3、functional-spec.md > 前提と未確定の点 | 試行の窓の設計は、通常の使い方で参加できなくなる。(1) 拒否中の試行も窓に加えるため、拒否された接続元が 60 秒おきより速く再試行し続けると、窓が空かず解除されない。(2) 信頼するプロキシの既定は「信頼しない」だが、デプロイは AWS の ALB の背後で動く。設定を忘れると全利用者の接続元がプロキシの 1 つのアドレスになり、誰かが 10 回間違えるだけで全員が参加できなくなる。(3) 教室では、1 つの NAT から 4 人以上が参加する。他人の誤入力で、正しいコードを持つ人まで拒否される。 | (1) 拒否された試行は窓に加えない、または拒否の継続時間に上限を設ける。(2) 本番と staging で、信頼するプロキシの段数を必須の設定にし、未設定ならデプロイ時に失敗させる。(3) 同じ接続元の共有を前提にして、10 回の仮の数値と、拒否中に有効なコードを通すかどうかを決める。決定を rules.md に書く。 | New |
| R-04 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/functional-design/rules.md > BR15.1、BR18.1 と entities.md > AccessCode | 観察者用コードは、期限がなく、試行の回数制限の対象にもならない。BR18.1 は観察者用コードによる要求を数えないと明記している。一方、NFR6 と契約 C4 の `issue` が強度を定めているのは、参加コード（8 文字以上）、進行役用コードと token（128 ビット以上）だけで、観察者用コードの強度が決まっていない。実装者が 8 文字相当で作れば、制限なしに総当たりできる。FR4.3 の「進行役が許可した」を取り消す手段（失効）も、BR15.1 の「失効していない」と entities.md の「期限を持たない」の間で定義されていない。 | 観察者用コードの強度（たとえば 128 ビット以上）を BR15.1 または C4 に書く。強度を上げない場合は、観察者用コードの無効な試行も BR18.1 の窓で数える。「失効していない」が何を指すのか（列、進行役の操作）を定めるか、その記述を削除する。 | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/functional-design/functional-spec.md > 状態ごとの観察者と参加者の見え方 と rules.md > BR16.1 | 仕様の表は、preparing の小売店について「第 1 週の値は、開始後に見える」としている。BR16.1 は「currentWeek までの需要を返す」だけで、状態の条件がない。preparing の currentWeek は 1 なので、BR16.1 のとおりに実装すると準備中に第 1 週の需要が見える。表と規則が食い違っている。 | BR16.1 に status が preparing のときは需要を返さない、という条件を書く。逆に準備中から見せる意図なら、表を直す。AC2.1.1 に準備中の例を足す。 | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/functional-design/entities.md > ObserverView（teamWeeklyCost、teamInventory、teamBacklog） | 未確定の週について、teamWeeklyCost は「直近の確定済みの週」と書かれているが、teamInventory と teamBacklog が同じ週のものかが書かれていない。currentWeek は進行中の週を指すため、画面で週と値がずれて見える。また、合計だけで内訳を逆算できないことは前提のままで、レビューで確かめるとされている。第 1 週の確定直後などに、総合計の差分から小売店の需要を推測できないかの確認が行われていない。 | 3 つの合計が同じ週のものだと、entities.md に明記する。初期状態と第 1 週の確定前後の例で、合計から役割別の値を逆算できないことを例示するか、制約として記録する。 | New |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/functional-design/rules.md > BR19.1 と BR17.2 | BR19.1 は「ゲームや役割の存在を応答の違いで明かさない」とするが、検査の順序を決めていない。入力検証（422）や状態の検査（409）を認可より先に行うと、資格情報のない呼び出しが 422 や 409 の違いから存在を知れる。プロジェクトの規約には「占有 → 認可 → 再送の照合 → 状態の検査」の順があるが、入力検証が認可より前か後かは、U4 の規則に書かれていない。また BR17.2 の lastUsedAt の書き込みが、GameSession の版の検査の対象か、別の書き込みかも決まっていない。ポーリングが入力の保存と版の衝突を起こす可能性がある。 | 認可（BR19.1）が、入力検証と状態の検査より先に行われると、BR19.1 に書く。lastUsedAt の書き込みは、集約の版を進めない独立した更新だと、BR17.2 に書く。 | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| Stage definition に列挙された検証ツール | 実行していない | この dispatch に検証ツールの指定がなく、手作業の相互参照で代替した。traceability.json の AC 12 件と coverage の BR 参照は、rules.md の ID と照合して全て解決した。U3 の BR10.2 への参照（BR17.5）は、兄弟 Unit の読み取りが許可されなかったため、確認していない。 |

### Summary

AC2.1、2.9、3.1、3.2、5.4 の全 12 件に規則と traceability の対応があり、観察者の集計値が役割別の値を漏らすことも見つかっていない。ただし、顧客需要を取得する経路が契約に存在しないこと、11 回目の判定が曖昧で窓の設計が通常の利用で参加を妨げること、観察者用コードの強度が未定で試行も数えないことの 3 つの Major があり、実装者が推測せずに作れる状態ではないため NOT-READY とする。
