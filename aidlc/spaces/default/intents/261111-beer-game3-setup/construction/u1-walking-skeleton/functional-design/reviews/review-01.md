## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-12T03:06:37Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/entities.md > AccessCode（codeHash）、rules.md > BR1.4、functional-spec.md > W1 手順 4 | 3 種のコードは「ハッシュだけ保存し、平文は作成の応答でだけ返す」と定めている。一方、`inception/refined-mockups/mockups.md` の S2 ロビーは、参加コード（例 ABCD-2345）を常時表示し、「参加コードを共有してください」と案内してコピーさせる。ハッシュしか持たない参加コードは、ページの再読み込み、別端末、進行役の再ログインのあとに再表示できない。参加コードは 8 文字の共有コードで、共有が本来の用途なので、ハッシュ保存と再表示が両立しない。進行役用コードを失ったときの扱いも決まっていない。 | 参加コードは再表示できる形で保存する（暗号化または平文）か、ロビーでは再表示しないと S2 を直すかを決める。進行役用コードと観察者用コードをハッシュのみにする場合は、紛失時の振る舞い（復旧なし、または再発行）を規則にする。entities.md の AccessCode と BR1.4 を、決めた内容に合わせる。 | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/rules.md > BR3.3、BR5.3、BR5.8 と entities.md > WeekRecord の制約 | 第 1 週の計算に使う「前週末在庫」「前週末受注残」「前週までの累積費用」の置き場所が決まっていない。BR3.3 は「各役割の在庫を初期在庫、受注残を 0 にする」と言うが、WeekRecord は確定前の結果の項目を null と定め、第 0 週の記録もない。BR5.3 と BR5.8 は前週の値を前提にしているので、第 1 週だけ別の出どころ（GameSettings.initialInventory、受注残 0、累積 0）が要る。また `remainingWeeks` の「1 は次の週に届く」という定義は、開始直後の第 1 週では「当週に届く」意味になり、初期の枠の読み方が曖昧である。 | 第 1 週の前週の値は GameSettings.initialInventory、受注残 0、累積費用 0 とする、と BR5.3 と BR5.8 に明記する。または第 0 週の初期状態の記録を持たせる。`remainingWeeks` の定義を「確定前の状態で、1 は当週の入荷になる」に直し、初期の枠と合わせる。 | New |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/rules.md > BR5.1、BR5.7、BR4.5、BR4.7 と functional-spec.md > W4、W5、エラーと端の場合 | 週の確定を拒否する条件のうち、ゲームが進行中でない（準備中、終了後）場合と、要求の週が currentWeek と違う場合（未来の週、確定済みの過去の週で別の識別子）の扱いがない。入力には BR4.5 があるが、確定にはない。さらに、識別子の再送を判定する順序（認可、再送、状態の検査）が W4 と W5 で食い違う。W5 は再送の判定を先に行うが、W4 は状態の検査（BR4.5）を再送の前に置いている。W4 の順では、確定後に遅れて届いた入力の再送が前回の結果でなく 409 になり、冪等の目的に反する。再送の記録は (gameId, key) で引くため、認可を先に行わないと、別の役割の応答が返る恐れもある。 | 週の確定に、進行中でないとき、週が currentWeek と違うときの拒否（409 state）の規則を足す。W4 と W5 に共通の判定順（認可、再送の照合、状態の検査、入力の検証）を定め、再送の照合には操作の種類と呼び出した人の種類を含めて、他の役割の応答を返さないと明記する。 | New |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/rules.md > BR1.1（applies_to）と entities.md > GameSettings | BR1.1 は `GameSettings.weekCount` を対象にするが、entities.md の GameSettings に weekCount はなく、Game にだけある。components.md は GameSettings にも weekCount を持たせている。また IdempotencyRecord を GameSession の所有としているが、components.md の GameSession の所有一覧にない。RoleAssignment には、components.md の 1 役割の定員 4 人を表す制約がない。 | weekCount の置き場（Game または GameSettings）を 1 つに決め、BR1.1 と components.md に合わせる。IdempotencyRecord の所有を components.md に足すか、差異を記録する。役割の定員 4 人を U1 で守るかを RoleAssignment に書く。 | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/functional-spec.md > エラーと端の場合（503）、rules.md > BR4.6 | 待てなかったときに 503 を返すとしているが、contract-summary.md の Problem の種類（validation、forbidden、not_found、conflict、state、rate_limited、internal）に対応するものがない。BR4.6 の「ゲームの行を一時的に占有する」は保存の仕組みそのもので、業務ルールの粒度を超えている。entities.md の `integer[]` と `json` の型も保存の都合の書き方である。 | 503 に当たる種類を契約に足すか、既存の種類に割り当てる。BR4.6 は「同じゲームへの書き込みを 1 つずつ順に処理する」という振る舞いで書く。型は「整数の並び」「構造化された値」に直す。 | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/entities.md > 契約への反映、functional-spec.md > この Unit の外で決まること | 「contract-summary.md の C3 の保存先の一覧は、この定義に合わせて直す」と書くだけで、C3 は直っていない。C3 は U1 の所有を 7 つの表に限り、return_tokens を U4 の所有、access_codes と idempotency_records を記載なし、と述べている。さらに C3 の `save(expectedVersion)` の版による衝突の拒否と、Q4 の直列処理（衝突を利用者に見せない）の関係が書かれていない。 | C3 を直す作業を、持ち主と時期つきで記録するか、C3 の記述をこの Unit の定義に合わせる。BR5.9 に、直列処理の中でも版の検査は安全装置として残す、と書く。 | New |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/functional-design/functional-spec.md > W4 手順 1、entities.md > WeekRecord | 参加者は確定前に当週の入荷と受注を見る（ステップ ②⑥ の表示）が、WeekRecord の receipt と ordersReceived は確定後にしか入らない。確定前の表示の出どころ（配送の枠の先頭、注文の枠の先頭、小売店は需要系列の当週の値）が書かれていない。 | W4 に、確定前の入荷と受注の表示は、各枠の先頭と当週の需要から求めると明記する。 | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| ruby YAML parse (entities.md) | PASS: 10 entities | YAML は読める。名前と所有者を確認した |
| ruby YAML parse (rules.md) | PASS: 34 rules, all with id/statement/category/source | 必須項目は揃っている |
| JSON parse (traceability.json) | PASS | 25 AC がすべて coverage にあり、対象の BR はすべて rules.md に存在する。reverse の 8 規則と合わせて 34 規則すべてが追跡されている |
| 手計算 AC1.5.3 / 1.5.4 / 1.5.9 | PASS | 16・0・4、4・8・0、800 が BR5.3 と BR5.8 の式で再現できる |
| 手計算 AC1.5.5 / 1.5.6 | PASS | 出荷と発注を、前進のあとの末尾（remainingWeeks 2）へ入れると、t+2 週に届く。ずれはない。4 役割を週の初めの状態から一度に求める、という定めで順序の差も出ない |
| 手計算 AC1.5.7（工場の特例） | PASS | 受注は注文の枠の先頭、入荷は生産の枠の先頭で、配送の枠はない。枠の種類と役割の制約（delivery は 3 役割、order は 3 役割、production は工場のみ）とも合う |

### Summary

数値の意味（出荷・発注の 2 週の遅延、工場の特例、費用の式）と、AC から規則への追跡は正しく、構文上の問題もない。ただし、参加コードをハッシュだけで持つ設計は S2 ロビーの再表示と両立しない。第 1 週の前週の値の置き場所と、週の確定の事前条件・判定順（再送、認可、状態）も定まっていない。この 3 件の Major を直してから進める必要がある。
