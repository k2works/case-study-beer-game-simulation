## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-13T01:26:14Z
**Iteration:** 2
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/functional-design/rules.md > BR16.2 and functional-spec.md > W2 手順 3 | BR16.2 は「顧客需要の取得要求」を 403 で拒否するとしているが、契約 C1 に顧客需要を取得する経路はなく、「契約への反映」にも新しい経路は載っていない。需要は小売店の投影に含まれるだけなので、AC2.1.2 の「拒否される」が、どの要求への 403 なのか決まらない。実装者は、経路を足すか、投影から省くだけにするかを推測することになる。 | 需要が小売店の状態投影の一部なのか、独立した経路なのかを決める。独立した経路なら、その経路を C1 への追加として「契約への反映」に書く。投影だけなら、BR16.2 を「小売店以外の投影に需要の項目がない」という規則に直し、AC2.1.2 をどの要求で検証するかを書く。 | Resolved (reviewer) |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/functional-design/rules.md > BR18.2 と BR18.1 | 11 回目の判定が矛盾している。「直近 60 秒の無効な試行が 10 回を超えている（11 回目の試行）」と書かれているが、11 回目の到着時に窓にあるのは 10 回で、超えてはいない。数えてから判定するのか、判定してから数えるのかが決まっていない。「有効なコードでも拒否中は参加できない」ので、コードの有効性の検査より前に窓を調べる必要がある。しかし BR18.1 は「無効なとき」だけ窓に加える。11 回目が無効な試行なら 403 なのか 429 なのかも書かれていない。AC5.4.2 の「11 回目で拒否」と NFR6 の「1 分あたり 10 回まで」は、実装によって 10 回目と 11 回目のどちらにも読める。 | 判定の順序を 1 つに決める。たとえば「窓に既に 10 回以上あれば、コードの有効性を見る前に 429 を返す。そうでなければコードを検証し、無効なら窓に加えて 403 を返す」とする。境界値の例（10 回目は 403、11 回目は 429、有効なコードの 11 回目も 429）を Given/When/Then で rules.md に書く。 | Resolved (reviewer) |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/functional-design/rules.md > BR18.2、BR18.3、functional-spec.md > 前提と未確定の点 | 試行の窓の設計は、通常の使い方で参加できなくなる。(1) 拒否中の試行も窓に加えるため、拒否された接続元が 60 秒おきより速く再試行し続けると、窓が空かず解除されない。(2) 信頼するプロキシの既定は「信頼しない」だが、デプロイは AWS の ALB の背後で動く。設定を忘れると全利用者の接続元がプロキシの 1 つのアドレスになり、誰かが 10 回間違えるだけで全員が参加できなくなる。(3) 教室では、1 つの NAT から 4 人以上が参加する。他人の誤入力で、正しいコードを持つ人まで拒否される。 | (1) 拒否された試行は窓に加えない、または拒否の継続時間に上限を設ける。(2) 本番と staging で、信頼するプロキシの段数を必須の設定にし、未設定ならデプロイ時に失敗させる。(3) 同じ接続元の共有を前提にして、10 回の仮の数値と、拒否中に有効なコードを通すかどうかを決める。決定を rules.md に書く。 | Resolved (reviewer) |
| R-04 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/functional-design/rules.md > BR15.1、BR18.1 と entities.md > AccessCode | 観察者用コードは、期限がなく、試行の回数制限の対象にもならない。BR18.1 は観察者用コードによる要求を数えないと明記している。一方、NFR6 と契約 C4 の `issue` が強度を定めているのは、参加コード（8 文字以上）、進行役用コードと token（128 ビット以上）だけで、観察者用コードの強度が決まっていない。実装者が 8 文字相当で作れば、制限なしに総当たりできる。FR4.3 の「進行役が許可した」を取り消す手段（失効）も、BR15.1 の「失効していない」と entities.md の「期限を持たない」の間で定義されていない。 | 観察者用コードの強度（たとえば 128 ビット以上）を BR15.1 または C4 に書く。強度を上げない場合は、観察者用コードの無効な試行も BR18.1 の窓で数える。「失効していない」が何を指すのか（列、進行役の操作）を定めるか、その記述を削除する。 | Resolved (reviewer) |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/functional-design/functional-spec.md > 状態ごとの観察者と参加者の見え方 と rules.md > BR16.1 | 仕様の表は、preparing の小売店について「第 1 週の値は、開始後に見える」としている。BR16.1 は「currentWeek までの需要を返す」だけで、状態の条件がない。preparing の currentWeek は 1 なので、BR16.1 のとおりに実装すると準備中に第 1 週の需要が見える。表と規則が食い違っている。 | BR16.1 に status が preparing のときは需要を返さない、という条件を書く。逆に準備中から見せる意図なら、表を直す。AC2.1.1 に準備中の例を足す。 | Resolved (reviewer) |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/functional-design/entities.md > ObserverView（teamWeeklyCost、teamInventory、teamBacklog） | 未確定の週について、teamWeeklyCost は「直近の確定済みの週」と書かれているが、teamInventory と teamBacklog が同じ週のものかが書かれていない。currentWeek は進行中の週を指すため、画面で週と値がずれて見える。また、合計だけで内訳を逆算できないことは前提のままで、レビューで確かめるとされている。第 1 週の確定直後などに、総合計の差分から小売店の需要を推測できないかの確認が行われていない。 | 3 つの合計が同じ週のものだと、entities.md に明記する。初期状態と第 1 週の確定前後の例で、合計から役割別の値を逆算できないことを例示するか、制約として記録する。 | Resolved (reviewer) |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/functional-design/rules.md > BR19.1 と BR17.2 | BR19.1 は「ゲームや役割の存在を応答の違いで明かさない」とするが、検査の順序を決めていない。入力検証（422）や状態の検査（409）を認可より先に行うと、資格情報のない呼び出しが 422 や 409 の違いから存在を知れる。プロジェクトの規約には「占有 → 認可 → 再送の照合 → 状態の検査」の順があるが、入力検証が認可より前か後かは、U4 の規則に書かれていない。また BR17.2 の lastUsedAt の書き込みが、GameSession の版の検査の対象か、別の書き込みかも決まっていない。ポーリングが入力の保存と版の衝突を起こす可能性がある。 | 認可（BR19.1）が、入力検証と状態の検査より先に行われると、BR19.1 に書く。lastUsedAt の書き込みは、集約の版を進めない独立した更新だと、BR17.2 に書く。 | Resolved (reviewer) |
| R-08 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/functional-design/rules.md > BR18.1 / BR18.2、entities.md > JoinAttemptWindow | 拒否された試行も窓に加えるため、拒否中に大量の要求が来ると接続元ごとの failedAt が上限なく増え得る。また窓の確認と追加が別の手順なので、複数の要求が同時に届くと、10 件を超えて検証に進む要求が出得る。保存先が未定で、台数が複数ならメモリ保存では接続元あたり 10 回を超えて通る点も、前提に書かれていない。 | 保存先を決める工程（NFR 設計、インフラの設計）への申し送りとして、窓の件数に上限を置くこと、確認と追加を一体で行うこと、複数台での共有を、前提と未確定の点に 1 行ずつ追記する。ブロックしない。 | New |

> R-01 Reviewer note: BR16.2 は専用の経路を設けず、顧客需要を GET /games/{gameId}/state の投影の項目としてだけ返すと明記した。契約 C1 に専用の経路はなく（C1 の状態取得のみ）、functional-spec の「契約への反映」とも一致する。小売店以外と観察者の投影から項目を除き、資格情報なしは状態の取得自体を拒否する。

> R-02 Reviewer note: BR18.1 が処理順（古い時刻を捨てる、10 件以上なら検証せず拒否して窓に加える、10 件未満なら検証）を定め、BR18.2 が 11 件目で 429 とすることを確定した。境界の例 4 件（9 回後の 10 回目は 403、11 件目は無効でも有効でも 429、60 秒後は参加可）が処理順と矛盾しない。403 と 429 の使い分けも明確で、有効なコードが 429 で参加できない点も明記されている。

> R-03 Reviewer note: 拒否中の試行が窓に加わる挙動は Q6 の人の決定として、境界の例とともに受け入れたトレードオフと記録された。信頼するプロキシの扱いは BR18.3 で既定を信頼しないとし、ALB の背後で未設定だと全員が 1 つの接続元になる影響と、NAT 共有の影響を明記した。デプロイの前提として確定する工程（インフラの設計と NFR 設計）も指定済みで、記述として十分である。

> R-04 Reviewer note: BR15.1 と AccessCode が、観察者用コードを進行役用コードと同じ強度（暗号論的乱数による 128 ビット以上）と定め、無効な試行を数えない根拠を示した。失効は revokedAt が空であることを有効の条件とし、U4 では失効の操作を設けず、実際にはゲーム削除まで有効であると明確になった。

> R-05 Reviewer note: BR16.1 が preparing では顧客需要を返さないと定め、functional-spec の状態ごとの表と一致した。

> R-06 Reviewer note: ObserverView の費用・在庫・受注残の合計は最新の確定済みの週の週末の値と定義され、確定前は初期状態の合計を返す。合計のみで役割別の内訳は逆算できない。「小さな値の組合せの推測」は前提として残るが、返す項目が合計に限られるため設計上の穴ではない。

> R-07 Reviewer note: BR19.1 が検査の順（資格情報、ゲーム・役割への権限、422、409）を定め、認可が先であることを明記した。BR17.2 は lastUsedAt の更新が return_tokens の行だけを更新し、GameSession の版の検査と履歴の対象にならないと明記した。プロジェクトの規則（占有、再検査、再送の照合、状態の検査）とも整合する。

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| traceability.json の確認 | AC2.1.1 から AC5.4.2 の 12 件がすべて OK で、対象の BR 番号は rules.md に存在する。逆方向 4 件も N/A の理由つきで妥当 | 参照の切れはない |
| 契約 C1 との突合（contract-summary.md） | customerDemand は C1 の状態の投影の項目、viewerKind に observer、429 rate_limited を含む | BR16.2、BR15.3、BR18.2 は契約と矛盾しない |

### Summary

前回の Major 4 件と Minor 3 件はすべて、処理順・境界の例・前提・受け入れたトレードオフの記述で解消された。残るのは窓の並行性と上限に関する Minor 1 件で、実装可能性を妨げない。
