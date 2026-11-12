## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-12T02:01:17Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/contract-design/contract-summary.md > C3 `GameSession.save: (game, expectedVersion)` と「失敗、時間切れ、再送」の C3 行 | ゲーム全体が 1 つの集約で、保存は集約全体の版で衝突を拒否する。4 役割が同じ週に同時に `PUT .../decisions/{role}` を送ると、通常の操作でも版の衝突が起きる。衝突した入力を誰が再試行するか、利用者にどう見せるかが書かれていない（C1 は「サーバーは自動で再試行しない」とだけある）。FR7.2、FR7.3 の通常経路が失敗しうる。 | 入力の保存について、衝突時にサーバーが読み直して再適用するのか、役割単位の版にするのか、画面が同じ `Idempotency-Key` で再送するのかを決めて書く。衝突時の HTTP ステータスと `Problem.kind` も決める。 | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/contract-design/contract-summary.md > C1 の OpenAPI の `paths` と `responses` | OpenAPI として使えるほど定まっていない。`{gameId}`、`{week}`、`{role}`、`{participantId}` の path パラメータが未宣言である。`POST /games`（3 種のコード）、`POST /games/join`（token）、`PUT assignments` と `PUT decisions` の要求本文、`POST confirm` の結果、`/results`、`/export` の応答本文に schema がない。`GameStateView` も、進行役の全役割の状態と観察者の集計値の形がなく、`mine` は `type: object` のみで、小売店だけの当週需要を置く場所もない。409、422、403 の多くが `Problem` を参照していない。FR4.1 の役割別投影を、型から検証できない。 | path パラメータと要求・応答の schema を足す。`GameStateView` を `viewerKind` ごとの形で定義し、他役割の項目が参加者の型に現れないことを型で示す。エラー応答はすべて `Problem` を参照する。401 と 403 の使い分けと、パスの `gameId` と資格情報の `gameId` が食い違う場合の扱いも書く。 | New |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/contract-design/contract-summary.md > C3 `storage.ownership` | 保存先を持たない契約がある。AccessControl の `AccessCode`（参加コード、進行役用コード、観察者用コード。U1 が発行する）と、U1 の最小の「参加者を特定する token」の表が、どの Unit にも割り当てられていない。`return_tokens` は U4 が足すが、U1 の token は U4 より前に必要である。C5 の `delete` が消す対象の表も確定できない。`submitDecision` と `confirmWeek` が `idempotencyKey` を受けるのに、識別子の保存先、有効範囲（ゲーム内か利用者ごとか）、保持期間、同じ識別子で内容が違う場合の応答も書かれていない。`components.md` の AccessCode と ReturnToken の所有（AccessControl）とも対応が取れていない。 | `access_codes` と U1 の token の表を U1 の所有に足すか、U4 の `return_tokens` との関係を決めて書く。冪等性の記録の保存先、有効範囲、保持期間、同一識別子で内容が異なる場合の応答（409 か 422 か）を定める。 | New |
| R-04 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/contract-design/contract-summary.md > 未確定の点（C4 の観察者用コード）と C1 の `POST /games` | 未確定の点が、決定済みの内容と矛盾している。ADR-005 は観察者用コードを作成時に発行すると決めており、`unit-of-work.md` の U4 も同じ書き方である。C1 の `POST /games` も 3 種のコードの発行を書いている。それでも「U1 に含めるか U4 で足すか」を未確定として U1 と U4 の両方を止めている。同様に、参加者 token の最小の形も、US1.4 の他役割の拒否が U1 の受け持ちなので、U1 に含めるしかない。契約が答えを持っていない。 | ADR-005 に従い、観察者用コードの発行を U1 の作成処理に含めると決めるか、ADR を改める。参加者 token の最小の形（U1）と U4 の追加分の境目を契約で確定し、この 2 件を未確定の点から外す。 | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/contract-design/contract-summary.md > C5 の `GameLifecycle` ブロック | YAML として読めない。`end: (gameId, reason: facilitator \| finalWeek \| autoEnd) -> Game` が「mapping values are not allowed」で失敗する（ruby の YAML で確認した）。ほかの shared-schema ブロックと OpenAPI は読める。 | 値を引用符で囲むか、疑似コードとして YAML の外に出す。 | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/contract-design/contract-summary.md > 契約の表 C5 と C5 の `delete` | C5 の提供者を U3 としているが、`delete` は U1（games など）、U3（`operation_log_entries`）、U4（`return_tokens`）、AccessControl の表をまたいで消す。U3 の受け持ちストーリー（`unit-of-work.md`）に削除はない。誰が実装し、どの順で消し、途中で失敗したらどうなるかが決まっていない。 | `delete` の実装の持ち主を決める（GameSession の U1 が自然）。削除を 1 回の保存の中で行うことと、後続の Unit が足した表を削除対象に足す規則を書く。 | New |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/contract-design/contract-summary.md > 契約の表と「失敗、時間切れ、再送」 | `components.md` の外部の依存のうち、Clock、RandomSource、Scheduler の境界が契約の表にない。いずれも試験で差し替える注入点（ADR-006 は Clock と乱数に触れないと決めている）で、Unit 間で形を揃える必要がある。Reporting の出力の形（CSV と JSON の列）と、AccessControl から Reporting への呼び出しも、C1 の `/results` と `/export` に schema がなく、契約として定まっていない。C5 と C4 の「失敗、時間切れ」の行も、表にない。 | Clock、RandomSource、Scheduler の最小のインターフェースを 1 つの契約にまとめる。Reporting の入出力を shared-schema に足し、C4 と C5 の失敗の扱いを表に足す。 | New |
| R-08 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/contract-design/contract-summary.md > 未確定の点（ポーリングの周期） | ポーリング周期は「数秒」、NFR3 は週確定後 2 秒以内の反映（仮の値）で、数値が矛盾しうる。この未確定は実在し、U1 と U6 を止める点も妥当である。ただし、Unit の独立デプロイと画面の実装に必要な周期の上限が決まらないと、U1 の画面が書けない。 | 周期の暫定値（例えば 2 秒）を契約に書き、NFR の工程で確定するまでの既定とする。 | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| ruby YAML parse, OpenAPI block | PASS（構文として有効） | path パラメータの未宣言など、OpenAPI としての不備は別途指摘した |
| ruby YAML parse, shared-schema ブロック 0〜2（C2、C3、C4） | PASS | 構文は有効 |
| ruby YAML parse, shared-schema ブロック 3（C5 GameLifecycle） | FAIL: mapping values are not allowed in this context at line 2 column 23 | 疑似コードの記法が YAML として壊れている（Minor） |
| 依存の図（DAG）と契約の対応の確認 | U2〜U5 の辺は C2〜C5 で対応する。U6 は検証のみで契約は不要 | 辺の対応は取れている。C3、C4 の consumer に U5 があるが、DAG では U3 経由の推移的な依存で矛盾しない |

### Summary

契約の表と DAG の辺の対応、所有の規則は大筋でそろっている。ただし、集約全体の版による同時入力の衝突、API の応答の形と path パラメータの欠落、コードと token と冪等性記録の保存先の不在、ADR-005 と食い違う未確定の点が残っている。開発者が推測なしに U1 を実装できる状態にはなっていないため、NOT-READY とする。
