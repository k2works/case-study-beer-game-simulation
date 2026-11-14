## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-13T03:10:02Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Minor | apps/beer-game3/tests/u4/features/authorization-matrix.spec.ts > 「無資格、別のゲーム、存在しないゲーム、別の役割、観察者の、すべての場合で 403」の actors | 同じゲームの参加者（自分の役割）を、進行役専用の経路（pause、start、confirm、codes、history、assignments）に当てる行が HTTP の網羅試験にない。「別の役割の参加者」は `:role` を含む経路にしか当たらない。参加者への拒否は access-control.spec.ts の単体（`authorize`）と pause の 1 件で守られているが、経路の表に行を足したとき、参加者による権限昇格が網羅試験で見つからない | actors に「同じゲームの参加者（役割あり）」を足し、`viewState` と自分の役割の `submitDecision` を除く全行で 403 を確かめる | New |
| R-02 | Minor | apps/beer-game3/migrations/1763100000000_u4-access-recovery.sql > `alter column last_used_at set not null` | `last_used_at` に既定値がない。ローリングデプロイで旧版のタスクが残っている間、旧版の `return_tokens` への insert（`last_used_at` を含まない）が NOT NULL 違反で失敗し、参加が 500 になる。逆の移行後の旧版は問題ない | 既定値 `default now()` を付けて not null にするか、旧版のタスクが残らない前提（停止してから移行）を README とデプロイ手順に明記する | New |
| R-03 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/code-generation/traceability.json > BR15.2 の target | BR15.2（観察者の書き込みの拒否）の target が `policy.ts` だが、このファイルは数値の既定だけを持つ。観察者に許す操作は `access-control.ts` の `OBSERVER_ACTIONS` にある。試験側の AC2.1.3、AC2.9.3、AC3.1.3 は、code-summary が「ストーリーに存在しない」とする ID を名乗っている | BR15.2 の target を `access-control.ts` に直し、存在しない AC の ID を試験名から外す（または実在する ID に付け替える） | New |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u4-access-recovery/nfr-design/security-design.md > NFR6.2 の観察者の投影の項目名 | 実装は entities.md に従い `teamWeeklyCost` などを使うが、security-design.md は `weekCostTotal`、`inputtedRoleCount` などの別名のまま。差分は code-summary に書かれているが、設計文書は直されていない。後続の Unit や運用が security-design.md を読むと食い違う | security-design.md の項目名を entities.md と実装に合わせる（または entities.md が正本である旨を追記する） | New |
| R-05 | Minor | apps/beer-game3/src/server/main.ts > `shutdown` | 停止時に `sweeper.stop()` だけで、実行中の掃除（`lastRun`）や応答後の `lastUsedAt` 更新（`pending`）の完了を待たずに `store.close()` する。失敗は catch されて warn になるだけで要求には影響しないが、プール終了後の例外のログが紛れる。あわせて `whenIdle` などの試験用の口が本番のインスタンスにも付く | 停止時に `await sweeper.lastRun()` と `app.whenIdle()` を待ってから `store.close()` する（試験用の口は許容でよい） | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| `npm --prefix apps/beer-game3 run test:u4`（DATABASE_URL=...:55432/beer_game3_test） | PASS: 14 ファイル、114 件 | code-summary の「U4 新規 114 件」と一致 |
| `npm --prefix apps/beer-game3 run verify`（同上） | PASS（終了コード 0）: typecheck、eslint、prettier、47 ファイル 504 件。カバレッジは文 94%、分岐 85.9%、関数 96.46%、行 93.8% | code-summary の主張（全緑、504 件、行 93.8%）は事実。分岐は 85.83 ではなく 85.9 で、閾値 80% を満たし、差は些少 |
| 手読みによる反証（認可の順、窓の原子性、投影、trustProxy） | 欠陥なし | 認可は `onRequest` で本文の解析より前、窓は `pg_advisory_xact_lock` と `lock_timeout` の下で、拒否時も行を追加し、有効なコードは数えず、接続元ごとに 11 件を保持する。`trustProxy` の `hop < hops` は proxy-addr の段数の意味と一致する。SQL はすべてパラメータ化されている。ログは許可リストで、資格情報も生のアドレスも出ない。観察者の投影は専用の型で、役割別の値を型に持たない。入口から GameSession を import すると ESLint が失敗し、構造の試験でそれを確かめている |

### Summary

致命的・重大な欠陥は見つからなかった。BR15〜BR20 と対象の受入条件は、実装と、規則を実際に確かめる試験（実 PostgreSQL の同時実行、lock_timeout、掃除、再起動の復元を含む）で満たされ、code-summary の検証結果の主張は再実行で事実と確認できた。残る指摘はすべて Minor（HTTP の網羅試験への参加者の追加、移行の既定値、追跡と設計文書の整合、停止時の後始末）で、READY を妨げない。
