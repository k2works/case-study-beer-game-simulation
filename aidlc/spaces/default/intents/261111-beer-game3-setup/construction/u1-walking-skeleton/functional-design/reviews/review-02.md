## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-12T03:12:13Z
**Iteration:** 2
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/entities.md > AccessCode（codeHash）、rules.md > BR1.4、functional-spec.md > W1 手順 4 | 3 種のコードは「ハッシュだけ保存し、平文は作成の応答でだけ返す」と定めている。一方、`inception/refined-mockups/mockups.md` の S2 ロビーは、参加コード（例 ABCD-2345）を常時表示し、「参加コードを共有してください」と案内してコピーさせる。ハッシュしか持たない参加コードは、ページの再読み込み、別端末、進行役の再ログインのあとに再表示できない。参加コードは 8 文字の共有コードで、共有が本来の用途なので、ハッシュ保存と再表示が両立しない。進行役用コードを失ったときの扱いも決まっていない。 | 参加コードは再表示できる形で保存する（暗号化または平文）か、ロビーでは再表示しないと S2 を直すかを決める。進行役用コードと観察者用コードをハッシュのみにする場合は、紛失時の振る舞い（復旧なし、または再発行）を規則にする。entities.md の AccessCode と BR1.4 を、決めた内容に合わせる。 | Resolved (reviewer) |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/rules.md > BR3.3、BR5.3、BR5.8 と entities.md > WeekRecord の制約 | 第 1 週の計算に使う「前週末在庫」「前週末受注残」「前週までの累積費用」の置き場所が決まっていない。BR3.3 は「各役割の在庫を初期在庫、受注残を 0 にする」と言うが、WeekRecord は確定前の結果の項目を null と定め、第 0 週の記録もない。BR5.3 と BR5.8 は前週の値を前提にしているので、第 1 週だけ別の出どころ（GameSettings.initialInventory、受注残 0、累積 0）が要る。また `remainingWeeks` の「1 は次の週に届く」という定義は、開始直後の第 1 週では「当週に届く」意味になり、初期の枠の読み方が曖昧である。 | 第 1 週の前週の値は GameSettings.initialInventory、受注残 0、累積費用 0 とする、と BR5.3 と BR5.8 に明記する。または第 0 週の初期状態の記録を持たせる。`remainingWeeks` の定義を「確定前の状態で、1 は当週の入荷になる」に直し、初期の枠と合わせる。 | Resolved (reviewer) |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/rules.md > BR5.1、BR5.7、BR4.5、BR4.7 と functional-spec.md > W4、W5、エラーと端の場合 | 週の確定を拒否する条件のうち、ゲームが進行中でない（準備中、終了後）場合と、要求の週が currentWeek と違う場合（未来の週、確定済みの過去の週で別の識別子）の扱いがない。入力には BR4.5 があるが、確定にはない。さらに、識別子の再送を判定する順序（認可、再送、状態の検査）が W4 と W5 で食い違う。W5 は再送の判定を先に行うが、W4 は状態の検査（BR4.5）を再送の前に置いている。W4 の順では、確定後に遅れて届いた入力の再送が前回の結果でなく 409 になり、冪等の目的に反する。再送の記録は (gameId, key) で引くため、認可を先に行わないと、別の役割の応答が返る恐れもある。 | 週の確定に、進行中でないとき、週が currentWeek と違うときの拒否（409 state）の規則を足す。W4 と W5 に共通の判定順（認可、再送の照合、状態の検査、入力の検証）を定め、再送の照合には操作の種類と呼び出した人の種類を含めて、他の役割の応答を返さないと明記する。 | Resolved (reviewer) |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/rules.md > BR1.1（applies_to）と entities.md > GameSettings | BR1.1 は `GameSettings.weekCount` を対象にするが、entities.md の GameSettings に weekCount はなく、Game にだけある。components.md は GameSettings にも weekCount を持たせている。また IdempotencyRecord を GameSession の所有としているが、components.md の GameSession の所有一覧にない。RoleAssignment には、components.md の 1 役割の定員 4 人を表す制約がない。 | weekCount の置き場（Game または GameSettings）を 1 つに決め、BR1.1 と components.md に合わせる。IdempotencyRecord の所有を components.md に足すか、差異を記録する。役割の定員 4 人を U1 で守るかを RoleAssignment に書く。 | Resolved (reviewer) |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/functional-spec.md > エラーと端の場合（503）、rules.md > BR4.6 | 待てなかったときに 503 を返すとしているが、contract-summary.md の Problem の種類（validation、forbidden、not_found、conflict、state、rate_limited、internal）に対応するものがない。BR4.6 の「ゲームの行を一時的に占有する」は保存の仕組みそのもので、業務ルールの粒度を超えている。entities.md の `integer[]` と `json` の型も保存の都合の書き方である。 | 503 に当たる種類を契約に足すか、既存の種類に割り当てる。BR4.6 は「同じゲームへの書き込みを 1 つずつ順に処理する」という振る舞いで書く。型は「整数の並び」「構造化された値」に直す。 | Resolved (reviewer) |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/entities.md > 契約への反映、functional-spec.md > この Unit の外で決まること | 「contract-summary.md の C3 の保存先の一覧は、この定義に合わせて直す」と書くだけで、C3 は直っていない。C3 は U1 の所有を 7 つの表に限り、return_tokens を U4 の所有、access_codes と idempotency_records を記載なし、と述べている。さらに C3 の `save(expectedVersion)` の版による衝突の拒否と、Q4 の直列処理（衝突を利用者に見せない）の関係が書かれていない。 | C3 を直す作業を、持ち主と時期つきで記録するか、C3 の記述をこの Unit の定義に合わせる。BR5.9 に、直列処理の中でも版の検査は安全装置として残す、と書く。 | Resolved (reviewer) |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/functional-spec.md > W4 手順 1、entities.md > WeekRecord | 参加者は確定前に当週の入荷と受注を見る（ステップ ②⑥ の表示）が、WeekRecord の receipt と ordersReceived は確定後にしか入らない。確定前の表示の出どころ（配送の枠の先頭、注文の枠の先頭、小売店は需要系列の当週の値）が書かれていない。 | W4 に、確定前の入荷と受注の表示は、各枠の先頭と当週の需要から求めると明記する。 | Resolved (reviewer) |
| R-08 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/functional-spec.md > 「役割とやり取りの形」末尾の遅延の枠の段落（40 行目） | 「remainingWeeks が 1 の枠は次の週に届き、2 の枠は 2 週後に届く」と書かれている。entities.md の PipelineSlot、BR5.4、BR5.5、W4 手順 1、週の計算の表は、1 を当週に届く枠、2 を次の週に届く枠としており、食い違っている。実装者がこの段落を読むと、1 週ずれた遅延を作る。 | この段落を entities.md の定義に合わせる。1 は当週に届く、2 は確定のたびに 1 に前進して次の週に届く、とする。 | New |
| R-09 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/rules.md > BR5.7 と BR5.11、および functional-spec.md の W5 手順 2 と 3 | BR5.7 は「当週が確定済み、または識別子の記録がある」ときに前回の結果を返すと書く。一方 BR5.11 は、再送でなく確定済みの過去の週、または進行中でないゲームの確定を 409 で拒否する。別の識別子で同じ週をもう一度確定する要求（AC1.5.8 の「もう一度届く」の解釈次第）に対する答えが 2 つある。また、確定と同じ保存に IdempotencyRecord の書き込みを含めるかが BR5.9 に書かれていない。 | BR5.7 の条件を、識別子の記録がある場合に限るか、別の識別子の確定済みの週も前回の結果を返すと BR5.11 側を直すか、どちらかに決める。BR5.9 に、IdempotencyRecord の書き込みが同じ保存に含まれると書く。 | New |
| R-10 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/rules.md > BR1.4、および functional-spec.md の W1 手順 4 | BR1.4 は参加コードと観察者用コードを進行役が何度でも見られると定める。しかし W1 は平文を作成の応答でだけ返すとあり、再表示を行う読み取りの手順は W1〜W5 のどれにもない。契約の GameStateView にも、コードとロビーの参加者一覧を返す項目がない。 | 進行役がコードを再表示する読み取りと、ロビーの一覧の取得を、機能仕様のワークフローに足す。W1 の「この応答でだけ」の文言を、進行役用コードに限る形に直す。契約への項目の追加は、contract-summary.md の持ち主の判断で決める。 | New |
| R-11 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/rules.md > BR4.7、BR4.8 | contract-summary.md の C1 は Idempotency-Key を必須（16〜128 文字）とする。しかし rules.md には、識別子が欠けている、または長さが範囲外のときの扱い（422 validation か）と、判定の順のどこで検査するかが書かれていない。 | 識別子の欠落と長さ違反を、422 validation で拒否すると規則に書く。判定の順では、認可のあと再送の照合の前に置く。 | New |

> R-01 Reviewer note: AccessCode に codeSealed を追加し、join と observer は暗号化して再表示可能、facilitator はハッシュのみと entities.md、rules.md BR1.4、entities.md の契約への反映で一致した。再表示を行う読み取りの経路が未定義な点は新しい指摘にした。

> R-02 Reviewer note: BR3.3 が第 1 週の前週末在庫（初期在庫）、前週末受注残 0、前週までの累積費用 0 と、枠の remainingWeeks 1 と 2 の初期値を固定した。BR5.3 と BR5.8 が参照している。PipelineSlot の remainingWeeks は 1 が当週に届くと定義された。手計算で、第 t 週の出荷が第 t+2 週の入荷になることを確認した。functional-spec.md 40 行目だけが逆の説明で残っており、新しい指摘にした。

> R-03 Reviewer note: BR4.5 と BR5.11 で状態の事前条件を追加した。BR4.8 で、認可、再送の照合、状態の検査、入力の検証の順に統一し、W4 と W5 も一致した。BR4.7 と IdempotencyRecord は呼び出した人（requesterId）を含めて照合し、他の人の結果を返さない。BR5.7 と BR5.11 に残る矛盾は新しい指摘にした。

> R-04 Reviewer note: weekCount を Game と GameSettings の両方に持たせ、作成時に同じ値を入れると明記した。役割の定員 4 は entities.md の RoleAssignment と BR3.2 に入った。IdempotencyRecord は GameSession の所有と宣言された。components.md の一覧はこの Unit の外で、まだ追記されていない。

> R-05 Reviewer note: Problem に unavailable（503）を追加し、BR4.6 の書き方も仕組みでなく振る舞いに直った。型は「整数の並び」と「構造化された値」になった。

> R-06 Reviewer note: contract-summary.md の C3 は、idempotency_records と access_codes を含む所有一覧、直列処理の決定、版の検査を安全装置として残す記述に更新された。BR5.9 が直列処理と版の検査を整理している。

> R-07 Reviewer note: W4 手順 1 が、確定前に見せる入荷と受注の出所を定義した。出所は、各枠のうち remainingWeeks 1 の数量と、小売店は需要系列の当週の値である。

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| entities.md の yaml 解析（ruby） | PASS（実体 10 件） | 構文は正しい。 |
| rules.md の yaml 解析（ruby） | PASS（規則 36 件） | 構文は正しい。BR1.1〜BR5.11 の重複はない。 |
| traceability.json の JSON 解析 | PASS | 構文は正しい。 |
| rules.md の BR と traceability.json の突合 | PASS | 36 件の BR すべてが coverage または reverse から参照されている。AC1.1.1〜AC1.5.9 の 25 件もすべて coverage にある。 |
| 手計算 AC1.5.3 / 1.5.4 / 1.5.9 | PASS | 12+4=16、充足対象 20 で出荷 16、週末在庫 0、週末受注残 4。12+0=12、充足対象 4 で出荷 4、週末在庫 8。8×50+4×100=800（$8.00）。 |
| 手計算 AC1.5.5 / 1.5.6、第 1 週の初期状態 | PASS（記述に矛盾 1 件） | 初期の枠 1 と 2 に各 4 を入れ、第 1 週の入荷は枠 1 の 4 になる。第 t 週の出荷と発注は第 t+2 週に届く。functional-spec.md 40 行目の記述だけが逆で、指摘済み。 |

### Summary

前回の 7 件はすべて直っており、枠の遅延の意味、第 1 週の初期状態、判定の順、保存先の契約の整合が確認できた。Critical と Major はなく、残るのは機能仕様の一文の逆転と、冪等性、識別子、コード再表示まわりの細かな詰めだけで、実装者が推測なしに作れる状態である。
