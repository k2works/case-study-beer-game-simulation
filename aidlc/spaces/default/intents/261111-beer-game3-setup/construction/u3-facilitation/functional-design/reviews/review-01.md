## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-12T07:22:31Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/functional-design/functional-spec.md > W5 担当者を入れ替える、契約への反映（C1 の表） | C1 にはすでに `PUT /games/{gameId}/assignments/{participantId}`（「役割を割り当てる、または担当者を入れ替える」、進行中は「同じ役割の入れ替えだけ許す」409）がある。U3 は同じ操作の入口として `POST /games/{gameId}/roles/{role}/replacement` を「新規」と書き、両者の関係を決めていない。さらに W5 手順 2 と BR10.1 は「他の役割への移動」を入れ替えの入口で 409 にするとしているが、`roles/{role}/replacement` は「その役割の旧担当者を新しい 1 人に替える」形しか受けないので、移動という要求そのものを表せない。移動を拒否する対象の入口は、実際には `PUT assignments` のはずである。AC2.6.2 の拒否がどちらの入口で、どう起きるかが決まらないまま実装すると、2 つの入口で入れ替えの規則が分かれる。 | 進行中と一時停止中の `PUT assignments` の振る舞い（常に 409 state とし、入れ替えは replacement を使うよう案内する、など）を決める。C1 の既存記述を同じ変更の中で直す。BR10.1 と W5 の手順 2 を、どの入口でどの要求が拒否されるかが分かる書き方に直す。 | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/functional-design/rules.md > BR9.4、BR9.8（および entities.md > Game constraints「遷移は ... のみ」、functional-spec.md > 前提と未確定の点「準備中のゲームの終了」） | 準備中のゲームの終了を、BR9.4 と Game の遷移の制約と状態の図が禁じている（preparing から ended への遷移はない）。一方、前提の表は「準備中のままの放置は U5 の自動終了の対象」としており、要件 NFR7 と前提（進行役用コードを紛失したゲームは放置として自動終了する）も同じ道を想定している。進行役用コードを失った準備中のゲームは、進行役が終了できず、自動終了も遷移の制約で拒否される。そのため終了しないままになり、保持期間も数え始められず、削除されずに残る。あわせて BR9.8 は終了を進行役用コードだけに限るが、C5 の `GameLifecycle.end(gameId, reason: facilitator, finalWeek, autoEnd)` は system からも呼ばれる。reason ごとに認可が違うことが書かれていない。 | 遷移の制約に「autoEnd に限り preparing から ended へ遷移できる」を足す（または U5 の対象を running と paused に限ると決め、準備中の放置を別の方法で扱う方針を決める）。前提の表の記述と BR9.4、Game の制約を一致させる。BR9.8 に、reason が facilitator のときだけ進行役用コードを要る、system の理由（finalWeek、autoEnd）は内部呼び出しで認可を通さない、と区別して書く。 | New |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/functional-design/entities.md > Game（endReason、constraints）、rules.md > BR9.4 | 進行役の終了は currentWeek を決めていない。U1 の Game は「終了時は currentWeek は weekCount のまま」と定めており、途中終了（たとえば 20 週のうち 5 週で終了）はこれに反する。U3 の Game の制約も currentWeek の扱いを足していない。途中終了した時点の当週の WeekRecord は、入力の途中（decision だけがあり isConfirmed が false）のまま残る。U5 の結果と出力が「終了した」ゲームの全週を読むとき、未確定の週をどう扱うか（含める、除く、途中終了として区別する）の根拠がない。U1 の既存の制約を、同じ変更の中で直さずに壊している。 | 途中終了のときの currentWeek を決める（終了時の週のまま、と U1 の制約を直す、など）。未確定の週の WeekRecord を結果や出力の対象に含めるかを決め、Game の制約か BR9.4 に書く。U1 の entities.md の該当制約を、同じ変更の中で直す（または直すことを契約への反映に明記する）。 | New |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/functional-design/rules.md > BR12.2、functional-spec.md > W7 | 置き換わりの検出は「自分が最後に保存した revision と異なる revision」を画面が持っていることを前提にしている。この記憶はブラウザ側にしかなく、再読み込み、復帰、入れ替え直後の新しい担当者（保存した revision を持たない）で失われる。最初のポーリングで、自分が入力していない値について「<ラベル> が <値> に変更しました」が誤って出たり、逆に出なかったりする。 | 「自分が最後に保存した revision を持たない画面は通知を出さない」などの規則を足す。または、サーバーが参加者ごとに最後に見せた revision を持つかを決める。 | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/functional-design/rules.md > BR10.6、entities.md > IdempotencyRecord | 入れ替えの要求は識別子を使わず、再送は 2 回目を 409 conflict にする。1 回目の応答が通信の失敗で届かなかった場合、平文の token が失われ、復旧は「新しい担当者を旧担当者として、もう一度入れ替える」になる。その結果、参加者が 1 人余分に作られ、joinOrder が飛び、ラベルが変わる（たとえば 太郎 #1 から #4 を経て #5）。 | 入れ替えにも `Idempotency-Key` を使うか、応答の喪失の場合の復旧手順（ラベルが変わること、joinOrder が飛ぶことを含む）を前提の表に明記して許容を決める。 | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/functional-design/rules.md > BR12.3、BR9.7 と、entities.md > RoleAssignment、Game > endReason | (a) 定員 4 人は U1 の entities.md が「U1 から守る」と定めており、BR12.3 は U3 の規則として同じ判定を置いている。どちらが実装とテストを持つかが曖昧である。(b) BR9.7 は「U1 の W5 の週の確定に足す」と書くが、U1 がすでに最終週で終了させているか（U1 の「終了時は weekCount のまま」から推定される）を示していない。また、U3 の移行前に終了済みの行の endReason は空になりうるが、U3 は「ended のとき endReason を持つ」を制約にしている。 | (a) 定員の判定の所有を U1 に置き、BR12.3 は AC2.2.2 の試験を U3 が持つと明記するか、BR12.3 を U1 の規則への参照にする。(b) 最終週の終了を U1 と U3 のどちらが先に行うかを書き、移行で既存の ended の行に endReason を補う（または空を許す）方針を決める。 | New |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u3-facilitation/functional-design/rules.md > BR9.3、BR9.5、BR11.4 | 一時停止中や終了後に、以前に成功した識別子の入力を再送した場合、保存した結果を返すのか、状態を先に調べて 409 state にするのかが決まっていない。画面の再送とゲームの状態の確認の順が実装者に任される。 | 識別子の照合と状態の検査のどちらを先にするかを、BR11.4 か BR9.3 に一文で決める。 | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| なし（stage 定義に検証ツールの記載がない） | 実行していない | traceability.json と rules.md の突合は手で行った。upstream_ids の 14 件の AC（AC2.2.1、AC2.2.2、AC2.3.1、AC2.5.1〜AC2.5.4、AC2.6.1〜AC2.6.3、AC2.7.1、AC2.8.1、AC2.8.2、AC5.6.1）は stories.md の AC と一致し、coverage が参照する BR と reverse の N/A を合わせると BR9.1〜BR14.3 の全 38 規則が漏れなく現れる。孤立した規則も、存在しない BR 参照もない。 |

### Summary

AC と規則の対応は完全で、traceability.json も rules.md と一致しており、情報の開示（BR12.2、BR14.2、BR13.6）にも明確な漏れは見つからなかった。ただし、入れ替えの入口が C1 の既存の入口と重なって規則の置き場所が決まっていないこと、準備中のゲームの自動終了の道が自らの遷移の制約で塞がれていること、途中終了が U1 の「終了時は weekCount のまま」を黙って壊していることの 3 件が、実装の前に決めるべき Major であり、Major が 2 件を超えるため NOT-READY とする。
