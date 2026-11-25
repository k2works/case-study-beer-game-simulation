---
type: Review
title: "設計書の再々レビュー - beer-game-scala（2026-11-25）"
description: "beer-game-scala の設計書に再レビューの高 8 件を反映した後（コミット 9203fc29）の再々レビュー。5 視点で、反映の検証と、反映で新たに生じた問題を調べた統合結果。前回の高 8 件は解消 3 件・一部 5 件。新たな指摘は高 10 件、中 17 件、低 11 件。対応方針は案で、人が確定する。"
tags: [review]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-25T15:00:00Z }
---

# 設計書の再々レビュー - beer-game-scala（2026-11-25）

## レビュー対象

- `docs/design/beer-game-scala/` の設計書 10 本と `index.md`、[ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md)。コミット `9203fc29` の時点。
- 前回: [設計書の再レビュー](./design_rereview_20261125.md)。高 8 件（N-H1〜N-H8）を反映した。ユーザーの決定は H3・H6・H7・H9・N-H4・N-H6・N-H7・N-H8 の 8 件と、ローカル DB（H2）の 1 件。他は AI の案で承認を得ていない。
- 5 視点とも**読み取り専用**で実施した。アーキテクトは Kotlin 版のコード（`Game.kt`・`SessionEvolve.kt`・`ReplaceDecision.kt`・`ProjectionLocks.kt` など）と許す組の表を、UX は実際の画面のソースと契約を、プロダクトは Kotlin 版 ADR 6 件の本文と正本の要件を、それぞれ自分で読んで突き合わせた。エージェントの出力は**モデルの出力**であり、ユーザーの承認ではない。

## 事実確認の結果（統合時に自分で確認した主な指摘）

| 指摘 | 結果 |
| :--- | :--- |
| ADR-001 と index の「US6.1（CI）」は正本と違う（PM） | **確認済み**。正本 `user_story.md` の US6.1 は「障害と性能の劣化を検知する」（運用担当、U6）で、CI ではない。ADR-001 75 行と index 52 行は「U1 の US6.1（CI）」と書く |
| session の許す組の表が欠落している（TS、AR） | **確認済み**。`domain-model.md` の EV-S06・S09・S10 の行はセルが 6 つで `Ended` の列が抜け、備考が列にずれている。EV-S04 は `Paused` が ○ だが、表の規則（`handle` が作る組だけ ○）と矛盾する（AR は Kotlin 版の `EndReason` が `FINAL_WEEK` だけと確認） |
| B1 確認項目 (e) に旧い画面文言が残る（UX、PM、TS） | **確認済み**。`architecture-backend.md` 326 行に「サーバーで問題が発生しました」が残る。`ui-design.md` #15 は `app.internal` の実物の文言「問題が発生しました。時間をおいて、もう一度お試しください。」に直済み |
| Scalafix で「落ちるべき」ソースの範囲が違う（TS、AR） | **確認済み**。`architecture-backend.md` 369 行は `application`・`adapter-http`、`test-strategy.md` 333・399 行は `application`・`adapter-persistence` |
| backend 345 行の案 A が「ロック以外」と書き、他と逆（AR） | **確認済み**。345 行は「`ConnectionIO` 全体（ロック以外の、認証 → …）」、213・267 行と test-strategy 216 行はロックを `program` の中とする |
| index 75 行の「上の 5 件の決定を除き」が古い（PM、TS） | **確認済み**。決定は 9 件（ローカル DB + 8）に増えている |
| 依頼文言が 2 通りある（PM、TS） | **確認済み**。`architecture-backend.md` 322 行（「…メモして待つ」）と `operation.md` 182 行（パターン 18） |
| test-strategy の B1 の表の「一定時間内」、operation の変更表 330 行の「Warning 3 秒」が古い（TS） | **確認済み**（473 行、330 行） |

## 総合評価

前回の高 8 件のうち、**解消は N-H5・N-H6・N-H8 の 3 件、一部は 5 件**。構造は反映され、`Tx.run`・M4（通知の出所）・読み取りを返す要件・範囲外の画面（#16）・97% の目安・案 C の検査は検査として働く形になった。承認の扱いも、「ユーザーの決定」と書いた記述が決定 8 件に結び付き、AI の案を承認済みと書いた箇所はなかった（PM が 10 文書で grep）。Kotlin 版 ADR 6 件の本文との突き合わせも一致した。

一方で、反映の中に**事実の誤りが 2 件**あり、承認を求める前に直す必要がある。(1) 範囲の指標が「US6.1（CI）」と書くが、正本の US6.1 は観測性で、CI ではない。観測性が U1 の約束から黙って抜ける。(2) 画面の文言の訂正が B1 の確認項目に届いていない。

設計の穴も 3 つ見つかった。**H2 版のロック**が Kotlin 版（`StampedLock`、`afterEnd`、待ちの上限）より後退していること、**`lock_timeout` と SQLSTATE（55P03・40P01）の写像**が抜けていること、**許す組の表に Kotlin 版の条件がなく、「失効済みの旧担当者の入れ替え」でゲームが止まる穴**があること（Kotlin 版の潜在不具合でもある）。許す組の表から生成器を作ると表と同じ前提に立ち、表そのものの漏れを見逃す、という構造の問題も指摘された。

## 前回の高 8 件の状況

| 前回 ID | 判定 | 要点 |
|---------|------|------|
| N-H1 `Started` の遷移・許す組の表 | 一部 | `Started` の腕と表は入った。session の表の欠落と誤り、Kotlin 版の条件の欠落、失効済みの旧担当者の入れ替えの穴、生成器の循環、受入テストの件数の食い違い（R-H3・R-H4） |
| N-H2 `ProjectionLock` | 一部 | PostgreSQL 版は筋が通る（接続 1 本、構造的な解放、試行ごとの取り直し）。H2 版の後退、`lock_timeout` と SQLSTATE の写像（R-H5・R-H6） |
| N-H3 `.transact(` の入口 | 一部 | 入口 4 つ・2 方向の表・`scalafix:off` 不使用は入った。3 文書の矛盾（R-H7）、`ReadTx`・`ModeTx`（M12） |
| N-H4 検証用 CI は U1 | 一部 | 決定の履歴と例外の節は誠実。代わりの条件が約束された範囲で裏付けられない（R-H2）、US6.1 の取り違え（R-H1） |
| N-H5 正本の規則 | **解消** | 4 文書が同じ規則になった。細部のみ（L10） |
| N-H6 97% は目安 | **解消** | 全文書で揃った。細部のみ（L10） |
| N-H7 止まったゲーム | 一部 | 要件と依頼文言は入った。(e) の旧文言（R-H10）、17 と 18 の見分け（R-H8）、紙で続ける数字（R-H9） |
| N-H8 研修に使わない | **解消**（UX は一部） | 理由つきで各文書の冒頭に明記された。#16 の導線の漏れ（M6） |

## 新たな改善提案（重要度順）

対応方針は**案**で、人が確定する。

### 高

| # | 提案 | 指摘元 | 理由 |
|---|------|--------|------|
| R-H1 | **成功の測り方の「U1 の US6.1（CI）」を直す。** ADR-001 75 行と index 52 行の「US6.1（CI）」を、正本の US6.1（障害と性能の劣化を検知する。AC6.1.1 構造化ログ、6.1.2 相関 ID つきの記録、6.1.3 メトリクス、6.1.4 `/ready`、6.1.5・6.1.6 通知）に直し、U1 に入る AC を人が決める（案: AC6.1.1・6.1.2・6.1.4。共有の features に `@AC6.1.1`・`@AC6.1.4` が実在する）。CI の `check` ジョブは US の受入条件でなく範囲の決定（N-H4）として別の行に書く。`test-strategy.md` 464 行は「US6.1・US6.2 は約束の外」で、ADR-001 と逆なので揃える | PM | 観測性（構造化ログ、`/ready`）が U1 の約束から黙って抜ける。v1 の失敗（運用の不足の後回し）の再発になる。範囲の指標の分母が文書で逆 |
| R-H2 | **例外の代わりの条件を、約束した範囲と揃える。** ADR-001 の「例外の間の条件」（Testcontainers の統合テストと受け入れテストを CI で実行）に対し、architecture-infrastructure は `integration`・`acceptance` を「時期は未決」とする。案 (a): 統合（PostgreSQL 18）と `@api` の受け入れを U1 の約束に入れる（`check` に含めるか別ジョブ）。案 (b): 代わりの条件を `check` の範囲に縮め、リスクを例外の節に書く。team.md の Testing Posture「主要境界の Integration Test を CI で実行」は、ADR の例外（デプロイだけ）でカバーされない | PM、TS | 代わりの条件が約束されていなければ、例外を承認しても趣旨が守られない。`adapter-persistence` 90% は統合の合算が前提で、統合が `check` に無いと行 80% が赤のままになりうる |
| R-H3 | **許す組の表を、Kotlin 版のコードで検証した正確な表に直す。** (a) session の表を全行 7 列に（EV-S06・S09・S10 の `Ended` の列）。(b) EV-S04 の `Paused` ○ は規則と矛盾するので直す（Kotlin 版の `EndReason` は `FINAL_WEEK` だけ）。(c) Kotlin 版の条件を表に書く（`invited` は既知の招待で変えない、`revoked` は未知の主体と失効済みで変えない、`reissued` は失効していない資格で変えない、`recovered` は失効済みで変えない、`withRole` は未知の参加者で変えない など）。(d) **EV-G08 の「失効済みの旧担当者」の扱いを人が決める**（Kotlin 版の `ReplaceDecision.kt` は旧担当者全員に `CredentialRevoked` を無条件に出し、`revoked()` は失効済みで `null`。案 (a): 未失効の旧担当者にだけ出す、案 (b): EV-G08 は失効済みに届いても冪等な ○）。受入テストに「失効 → 入れ替え → 新担当者が保存・確定 → 再生しても同じ状態」を足す。(e) `SessionEvents.apply` のスケッチを置く | AR、TS | 条件なしの ○ のままだと、Kotlin 版の条件を足したときに「失効 → 入れ替え」の自然な流れが `Ignored` → 500 になり、入れ替えた時点でゲームが止まる |
| R-H4 | **性質テストの「`Ignored` にならない」生成器を、表からでなくコマンドから作る。** (a) 状態に応じたコマンド列（`handle`・`assignRoleAfterStart` を通す）を `foldLeft` し `Ignored` が 0 件（表の漏れを捕まえる）、(b) 表の各 ○ の組が (a) の列の中で N 回以上現れる（`collect`。表が広すぎないか）、(c) 表 × `apply` の全組の状態遷移テスト（現案）。生成器に「失効 → 入れ替え」の流れを明示する。B1 の表に「表の ○ を 1 つ × に変えると (a) が落ちる」「`apply` の腕を 1 つ消すと (c) が落ちる」を基準として足す。表は、テストが読む値と同じ 1 か所から生成するか、テストで Markdown の表を読んで突き合わせる | TS、AR | 表から列を作ると、表と `apply` が一致することしか確かめられず、表自体の漏れ（P1 の本当の原因）を見逃す |
| R-H5 | **H2 版の `ProjectionLock` を Kotlin 版に揃える。** Kotlin 版の `LocalProjectionLock` は `StampedLock`（取得と解放のスレッドが違ってよい）、`tryReadLock`/`tryWriteLock` の上限（超えたら `RetryExhausted`）、トランザクション終了のフック `afterEnd` で COMMIT の後に解放する。Scala 版の「`bracket`、COMMIT の前に解放する弱点を許容」「`ReentrantReadWriteLock` など」は、事実と合わず（`ReentrantReadWriteLock` は所有スレッド固有で、`Fiber` は別スレッドで再開しうる）、待ちの上限もない。案: `Tx` の実装に終了後の後始末の登録を持たせ、`Tx.run` が COMMIT・ROLLBACK の後に `guaranteeCase` で実行し、ロックは `Fiber` から安全な部品にして上限を置く。別案: 1 ゲーム 1 行のロック行に `SELECT … FOR UPDATE`（H2 での動作は未確認） | AR | 契約の「COMMIT の後まで直列化する」条項を両実装で確かめられず、弱点を許容する羽目になる。実行時の挙動の問題で、B1 の最初のスライドで動かして確かめる |
| R-H6 | **`lock_timeout` の効く範囲と、例外で届く SQLSTATE の写像を設計する。** Kotlin 版は `set_config('lock_timeout', ms, true)` をロックを取る間だけ設定し、取った後に `'0'` に戻して投影の行のロック待ちに効かせない。Scala 版の data-model 252 行（ログインユーザー・接続の `options`・接続後の `SET`）は、投影の行のロック待ちにも効き、平常時でも 503 が出る。55P03・40P01・40001 は `Left` でなく**例外**で届くので、`loop`（`Left(ConcurrencyConflict)` しか見ない）と backend 408 行の方針（例外は `Persistence` 500）では NF-R17（503）も 40P01 の再試行も実現できない。案: `withShared`/`withExclusive` を Kotlin 版と同じ手順にし、55P03 は `attemptSomeSqlState` で `Left(RetryExhausted)` にして即返す（中断したトランザクションで次の文を出さない）、40P01・40001 は `Tx.run` の後の `IO` で `ConcurrencyConflict` に写して `loop` に戻す | AR | 書いたとおりでは NF-R17 が実現できず、平常時に 503 が出る |
| R-H7 | **`.transact(` の受入条件を 1 つの表にまとめ、3 文書の矛盾を解く。** テストのソースの扱いが 3 通り（test-strategy: テストにも有効で `TestTx` だけ除外、architecture-backend: `Test` は対象にしない案、tech-stack: テストのソースは落ちない）。文字列・コメントの中の語の期待が逆。落ちるべきコードの置き場も違う（`application`・`adapter-persistence` と `application`・`adapter-http`）。「`Transactions.scala` 以外の全 `Compile` のソース」に揃え、テスト本体の `.transact(` は落ちる行を表に足す | TS、AR | 判定を決定的にできない |
| R-H8 | **パターン 17 と 18 を利用者がどう見分けるかを決め、依頼文言を「同じ操作が 2 回続けて失敗したら、それ以上操作せず、相関 ID を書き写して運営者に伝える」の形にする。** 両方とも `AppFailure.Persistence`・500・`type` つきで、画面は同じ `app.internal` の文言になり、パターン 17 は再操作を、パターン 18 は繰り返さないことを求める。判別は運営者側の監視（`Ignored` のメトリクス、`idle in transaction`）だけで行う。未決事項 8 の受入条件の案 (a) の「続くとき」を Given/When/Then で書き直す（例: 同じタブで同じゲームへの操作が `app.internal` で 1 回失敗した状態で、もう一度失敗したら、再操作を促さず「操作を繰り返さず、相関 ID を運営者に伝えてください」と示す）。相関 ID は操作した人のタブにだけ出て、Play の「手動更新」の成功で消える（PlayPage.tsx 90 行の `setFailure(null)`）ので、文言を「まず相関 ID を書き写す（または画面を撮る）。そのあと手動更新を押してよい」の順にし、誰の画面に出るかを書く | UX | 利用者にも進行役にも、どちらが起きたか分からず、逆の指示が出る。相関 ID が最も押しやすい操作で消える |
| R-H9 | **紙で続けるための依頼を、現場で回る内容にする。** (a) 控える数字に「入荷予定（輸送中の品）」と「上流へ送って未着の発注」を足す。4 役割を一度に見られるのは進行役のコンソールだけなので、控える場所をコンソールに指定する。コンソールは自動更新されないので、控える前に再読み込みする手順を入れる。B1 確認項目 (b) にも入荷予定が返ることを入れる。(b) 紙に移るときに各週・各役割の発注数を記録させ、復旧後に代理入力と週ごとの確定で追いつく手順を書く（追いつきが同じ数字になるかは golden で確かめる候補）。(c) 15 分を待たず進行役の判断で紙に切り替えてよいことを明記する | UR、UX | 入荷予定がないと翌週の入荷が決まらず、紙に移った瞬間に数字が狂う。復旧後に戻る手順がなく、振り返りのデータが欠ける |
| R-H10 | **B1 確認項目 (e) の画面文言を、`ui-design.md` #15 の実物に直す。** 文言を複製せず #15 へのリンクで参照する。コンソールでは `extra`（「最新状態を確認して、再度操作してください。」）が付く | UX、PM、TS | 正しい実装を不合格にする |

### 中

| # | 提案 | 指摘元 |
|---|------|--------|
| M1 | team 規約の例外の前提と記録先を決める。team.md の Way of Working・Deployment は beer-game3 を対象に書かれており、test-strategy 413 行は「beer-game3 用**とは別に**」と原文の意味を変えて引用している。規約が beer-game-scala に及ぶかを承認と同じ場で確認し、及ぶなら承認した例外を ADR だけでなく project.md の `## Scope Overrides`（現在は空）に learnings の手続きで記録する | PM |
| M2 | `index.md` 75 行の「上の 5 件の決定を除き」を直し、決定の件数の数え方を揃える（index は「9 件（ローカル DB + 8）」、ADR-001 24 行・data-model 448 行・domain-model 602 行は「8 件」） | PM、TS |
| M3 | 「許可リストを `@AC` から機械的に導く」は、unit_definition の U1〜U3 に AC の番号まで書かれていない項目（US1.2 共同担当を除く、US6.1 基本、US6.2 ステージングまで、US3.1、US3.2、US2.4）があり、書いたとおりには実行できない。B1 の計画で U1〜U3 の AC の一覧を AC の番号まで確定し（人の承認つき）、それを入力にして導くと書く | PM |
| M4 | 依頼文言の正本を `operation.md` パターン 18 の 1 か所にし、`architecture-backend.md` 322 行は参照だけにする | PM、TS |
| M5 | `operation.md` の監視閾値を揃える（75 行は Warning を「実測の後に決める」、変更表 330 行は「Warning 3 秒・Critical 4 秒（提案）」。75 行は Critical 4 秒に「ユーザーの決定」を並べているが、ユーザーが決めたのは NF-P2 だけで閾値は案） | PM、TS |
| M6 | `ui-design.md` #16 の導線を完全にする。観察（S07）も終了後に「振り返りを見る」を出す（ObservationPage.tsx 156〜160 行）。「保持状態を見る」は最終週の後ではなく、開始後のコンソールに常に出る（ConsolePage.tsx 391〜393 行）。S04 ロビーの観察者の招待パネル（LobbyPage.tsx 200 行）と S10 `/observe` も、観察者が U4（ADR-001 86 行）なら範囲外の API を呼ぶ。`ExportButtons` は U1〜U3 では描かれず、画面に見える失敗は S08 と S09 の 2 つだけ。観察を「範囲の表で決める」と未決にせず、ADR-001 の U4 に結ぶ | UX、UR |
| M7 | 止まったゲームでも返す読み取りの対象を、メソッドつきの 4 経路（観察を範囲外にするなら 3 経路）に揃え、NF-R9・test-strategy 481 行・operation 194 行・architecture-backend 325 行・B1 の表・確認項目 (a)〜(e) を同じ列挙にする（B1 の表は (c) 他のゲームは通る、(d) メトリクスが欠ける） | UX、TS |
| M8 | 依頼文言を「進行役がすること」（コンソールを再読み込みして結果表を撮る、相関 ID を 1 つ運営者に伝える）と「進行役が参加者に伝えること」（保存を押さない、自分の在庫・受注残・入荷・受注と**未保存の数量**を書き写す）に分け、参加者（S05）・進行役（S06）・観察者（S07）ごとに控える数字を書く。止まったことに気づくのは次に操作した人だけなので、人の側の検知の手順（全員の保存が 1 分以上進まなければ、進行役がコンソールを再読み込みして確認する）を足す | UX |
| M9 | 契約テストの「ルートの網羅」（test-strategy 269 行）は、共有の openapi に `getReview`・`getExport`・`getRetention` があり U1〜U3 では実装しないので、U1 の `check` ジョブが落ちる。範囲外の操作の許可リスト（U1〜U3 の `@AC` から導く）を持ち、#16 の「経路なし」の応答を `request.not_found` に写すかを同じ箇所で決める | UX |
| M10 | 入れ替えの受入テストを整える。domain-model は 4 件、test-strategy は「2 件を足す」で、復帰・再発行と、開始後の入れ替え後の保存・確定が載っていない。「当週の旧担当者の入力が残り、新担当者に最新値と保存者が見える」（Kotlin 版 624 行）を足す。入れ替えの業務上の出どころ（AC3.2.5 の本文は「資格の失効と再発行」で、開始後の入れ替えは Kotlin 版で足した業務ルール）を 1 行書く。共有 `credentials.feature` との分担（`@AC3.2.5` か munit か）も決める | TS、UR |
| M11 | 進行役向けの 1 枚の案内（operation 3b、ui-design 8c）に、準備中に予備の参加者を参加させておくこと（開始後の参加は受け付けない）、予備がいない場合に残りを代理入力で続けられること、研修 1 回が 90〜120 分で 5〜10 分止まると場が冷えることを入れる | UR |
| M12 | 読み取りの入口 `ReadTx` を `application` の trait（参加者用と観察者用の 2 つの型）にし、生の `Transactor` を `application` から消す。`QueryPorts` が生の `Transactor` を渡す現案では、`application` が `.transact(` を使えず実行する合法な経路がない。`ModeTx` も `Tx.run` と同じ規則（`Left` なら `FC.rollback`）を使うと明記する（K5 の「`Left` でも COMMIT」の罠が戻る） | AR |
| M13 | 反映で生じた矛盾を直す。backend 345 行の「ロック以外の」、処理の順の「通知 → 冪等記録の保存 → COMMIT」（backend 211・345 行、test-strategy 216 行）とコード（290〜297 行）の逆順、test-strategy 103〜104 行（H2 版で保証する範囲、通知の出所）と backend 198・312 行、test-strategy 103〜104・207・573 行の契約の分類が backend 387〜394 行の (T)(N) 分類・スナップショットと別 | AR |
| M14 | Scalafix のパターンを変数名に依存しない形にする（`xa.trans` は `writeXa.trans`・`transactor.trans` をすり抜ける。`\.trans\b`・`\.rawTrans\b` のようにメソッド名で）。`scalafix:off` を `DisableSyntax.regex` で検出できるかを未確認の一覧（K15）に足す。2 方向の検査を一度きりの確認でなく、違反するコードとしないコードの fixture と期待件数のテストとして `check` に入れる | TS |
| M15 | カバレッジのジョブが赤のままだとマージが止まる問題を書く（算出スクリプトとそのテストを B1 の最初のスライドに置く）。B1 の表の「成り立たなければ」の「手元の同じコマンドを正とし」は N-H4 の決定を弱めるので外す。算出スクリプトの境界値に丸めを足す（7999/10000 = 79.99% が表示の丸めで 80.0% になって通らない。比較は有理数か整数の積で行う） | TS |
| M16 | 古い記述を直す。test-strategy の B1 の表の `Fiber` の行（473 行）の「一定時間内」を「2 秒」に。CI の図（417〜444 行）が全工程を「毎回」としているのを、U1 の `check` 1 本と区別する | TS |
| M17 | 研修に使い始める前提の時期を揃える。architecture-backend 327 行は「U4 以降の判断」、operation 23 行と 3a は「U5 以降」。ADR-001 97〜100 行の理由は U4（US4.2 の振り返り）と U5（US5.1 の保持削除）の両方なので「U4 と U5 の判断の後」に揃え、U5 着手の条件として運営者との合意（依頼文言・15 分・研修中の原則）を 1 行置く | PM、UR |

### 低

| # | 提案 | 指摘元 |
|---|------|--------|
| L1 | ADR-001 85 行の「`check` ジョブ 1 本: formatter・linter・type-check・テスト」の内訳は AI の補い。決定は「`check` ジョブ 1 本」まで | PM |
| L2 | デプロイを「後回し（U5）」とするのは AI の整理。Unit 定義ではステージングは U1（US6.2）にあるので、「後回し（再開するときに Unit を決める）」とするか、付け替えを案と明記する | PM |
| L3 | 引き継ぎ表の 006 の行に、書く版の切り替えが確認必須（承認ゲート）であることと未決 2 点を足す。012 の行に、CI のコンプライアンス（Undefined・Pending で失敗）は `acceptance` ジョブが範囲に入るまで果たせない旨を注記する | PM |
| L4 | NF-P2 の測定の対象から S04（ロビーのポーリングは準備中だけ）を外す。「同一の時計（確定した側のブラウザの時刻）」は複数端末では成り立たないので、B1 では同じ機械の複数タブで測るなどの前提を書く | UX、TS |
| L5 | #16 に、範囲外の画面が行き止まりになる（戻る導線がない。ブラウザの戻る）、「経路なし」の JSON でない 404 では相関 ID が出ないことを書く | UX |
| L6 | test-strategy の「開始後の入れ替え・復帰」の行が `RoleHolderReplaced` を `Started`（game）で受けるイベントとして並べている。これは session のイベントで、受けるのは `Active`・`Paused` | TS |
| L7 | CI のトリガーを team の `develop` 統合に合わせる（test-strategy の図は PR / main へのプッシュ、infra は `develop`・`main`） | TS |
| L8 | `adapter-persistence` の `object Tx` が `application` の `trait Tx` のコンパニオンに見える。`DoobieTx` や `Transactions.writeTx(xa)` にする。PostgreSQL のロックは排他を待つ要求があると後から来た共有もその後ろで待つ（飢餓を防ぐ挙動。未実測）ので、再構築の間はそのゲームの新しいコマンドが止まる。`lock_timeout` を NF-P18 と比べて決める | AR |
| L9 | index 101 行の「K5・K8〜K17 は実 DB と道具で確認」は K6（スタブの `Connection`）を落としている | AR |
| L10 | index 110 行に「唯一の正本」の語が残る（規則とは矛盾しない）。ADR-001 の成功の測り方の行カバレッジの「設定できなかったときの扱いも、その時に決める」を、他の文書の「全体のしきい値だけにし、97% は目安のまま」に揃える | TS |
| L11 | 許す組の表の未確認（Kotlin 版の `revoked`・`reissued`・`recovered` が未知の主体を無視するか。未決事項 13）は、AR が上の (c) で読んで確認したので、未決事項 13 を閉じ、残る未確認だけにする | AR |

## 人の判断が要る論点

| # | 論点 | 推奨判断（案） |
|---|------|----------------|
| 1 | R-H2: 統合テストと受け入れテストを U1 の約束に入れるか | 入れる（案 (a)）。ADR-012 のコンプライアンス（Undefined・Pending で落とす）との関係からも |
| 2 | R-H1: U1 に入れる US6.1 の AC | AC6.1.1・6.1.2・6.1.4。CI は範囲の決定として別の行に書く |
| 3 | R-H3 (d): 失効済みの旧担当者の入れ替えの扱い | 案 (a)（未失効の旧担当者にだけ `CredentialRevoked` を出す）か案 (b)（EV-G08 を冪等な ○ にする）のどちらか |
| 4 | R-H5: H2 版のロックを Kotlin 版と同じ構造にするか | `StampedLock` + 終了後の後始末（`afterEnd` 相当）。`FOR UPDATE` は別案 |
| 5 | M1: team 規約が beer-game-scala に及ぶか、例外の記録先 | 及ぶ場合は project.md の `## Scope Overrides` に記録 |

## 懸念事項（複数視点）

- **止める設計の安全性は、表が Kotlin 版の `decide` の出すイベントと一致することにかかる**: 表を Kotlin の `evolve` から写すだけでは、`decide` が `evolve` の受けない列を出す穴（失効済みの旧担当者への `CredentialRevoked`）は防げない。生成器をコマンドから作る（R-H4）ことが先に要る。
- **画面は止まったことを誰にも知らせない設計のまま**: 読み取りを返す要件を満たすほど、S05・S07 は普段どおりに見える。気づくのは操作した人だけで、気づくまでの間を依頼文言は埋めない。
- **新しいコードはすべて型検査していない**: `Tx.run`、`withShared`、`Transactions.scala`、12 個の `GameEvent`。R-H5・R-H6 は実行時の挙動（スレッドの所有、例外の経路、`SET LOCAL`）なので、B1 の最初のスライドで実際に動かして確かめる。project.md の Testing Posture どおり、土台を変えるスライドで後続の試験を先に書く。
- **例外を承認できる材料が揃っていない**: 規約がこの範囲に及ぶか（M1）、代わりの条件が約束されているか（R-H2）、承認後の記録先。
- **U1〜U3 は研修に使わないことが文書だけで守られている**: 画面にも起動時の表示にも出ない。AWS 環境が後回しなので誤解の危険は低いが、U4 以降でステージングを作るときに前提が崩れる。

## スコープ外の発見（正本・共有物の側）

- **Kotlin 版の潜在不具合**: `assignRoleAfterStart` が失効済みの旧担当者にも `CredentialRevoked` を出し、`replayGame` が `InvalidTransition` として記録する。`ReplaceRoleSpec.kt` にこの組のテストがない（AR）。
- Kotlin 版 `domain-model.md` の session の状態遷移図（652〜653 行）の「Paused → Ended」「進行役の終了」は、コード（`EndReason` は `FINAL_WEEK` だけ）にない。図がコードより広い（AR）。
- 正本の要件で US6.1・US6.2 の Unit が食い違う: `user_story.md` 59〜60 行は「U6」、`unit_definition.md` 94〜95 行は「U1（基本）・U5（完成）」（PM）。
- Kotlin 版 ADR-016 も、017・019 と同じ自己矛盾（ステータス節は承認済み、タイトルは「（提案）」、冒頭は「ADR としては提案中のまま」）を持つ。ADR-015 もタイトルが「（提案）」。Scala 版 ADR-001 はステータス節を根拠に承認済みと数えている（PM）。
- team.md・project.md の規約は beer-game3 を対象に書かれているが、Kotlin 版・Rust 版・Scala 版にも当てはめて運用されている。範囲を team.md に明記する価値がある。project.md の Mandated と Forbidden は 2026-10-27 と 2026-11-11 の同じ文が重複している（PM）。
- Kotlin 版の `ProjectionLocks.kt` の「SET LOCAL でロックを取る間だけ上限」の設計が、Rust 版でも同じかを確かめる価値がある（AR）。
- 共有の画面の課題（全実装共通）: Play の「手動更新」が失敗の通知（相関 ID）を消す（PlayPage.tsx 90 行）。コンソールには更新の手段がないのに「最新状態を確認して」と案内する（ConsolePage.tsx 291 行）。PlayPage.tsx 296 行は `roleStatus === undefined` のときも「終了しました」と出す。ロビーの招待パネルは常に出る（LobbyPage.tsx 200 行）（UX、UR）。
- 共有の `credentials.feature` の 111〜115 行のコメントが Kotlin 版の経緯のまま。「開始後に参加できる人はいない（入れ替えの対象は開始前に参加し、役割を持たなかった参加者だけ）」は受入テスト 2 のテストデータの前提になる（TS）。
- 紙で続けた後の追いつき（代理入力と確定の繰り返し）は Kotlin 版・Rust 版の運用手順にもない（UR）。

## エージェント別の件数

| エージェント | 高 | 中 | 低 |
| :--- | ---: | ---: | ---: |
| xp-product-manager | 2 | 5 | 5 |
| xp-architect | 3 | 5 | 3 |
| xp-interaction-designer | 3 | 5 | 3 |
| xp-tester | 5 | 6 | 5 |
| xp-user-representative | 2 | 4 | 3 |

上の表は、各報告の「新たな改善提案」の件数を統合者が数えた値で、本文の統合後の番号とは重複を除く分だけ異なる。各エージェントの全文はこの文書に転記していない。根拠となる文書名・行は、上の表と事実確認の結果に残した。

## 対応状況（2026-11-25）

ユーザーが「決定を行い、高 10 件を設計書に反映」と指示したため、論点 1〜5 は **AI が推奨案で決めた（D1〜D5）**。これはユーザー本人が選択肢を選んだ決定ではなく、**確認は未了**で、設計書では「ユーザーの指示に基づき AI が推奨案で決めた（確認は未了）」と書き、ユーザーの決定（本人が選んだ 8 件 + ローカル DB の 1 件）と区別した。

| 決定 | 内容 | 区分 |
|------|------|------|
| D1 | 統合テスト（PostgreSQL 18）と `@api` の受け入れテストを U1 の約束に含める（`check` に含めるか別ジョブかは案 X・Y で人が決める） | AI が推奨案で決めた（確認未了） |
| D2 | U1 に入れる US6.1 の AC は AC6.1.1・6.1.2・6.1.4。AC6.1.3・6.1.5・6.1.6 と、AC6.2.4 を除く US6.2 は約束の外 | 同上 |
| D3 | 失効済みの旧担当者の入れ替えは、未失効の旧担当者にだけ `CredentialRevoked` を出す | 同上 |
| D4 | H2 版の `ProjectionLock` は Kotlin 版と同じ構造（`StampedLock` 系 + 待ちの上限 + `Tx.run` の後始末） | 同上 |
| D5 | team 規約が beer-game-scala に及ぶかの確認と、例外の project.md `## Scope Overrides` への記録は、人の承認の場で行う（AI は project.md を編集しない） | 同上（記録は未実施） |

| # | 対応 | 主な反映先 |
|---|------|------------|
| R-H1 | 「US6.1（CI）」を正本の US6.1（障害と性能の劣化を検知する）に直した。U1 は AC6.1.1・6.1.2・6.1.4。`@AC6.1.1`・`@AC6.1.4` は `operations/observability.feature` にあるが、AC6.1.2 の共有シナリオはなく munit で保証する案。US6.1・US6.2 の Unit の食い違い（正本側）を注記 | ADR-001、index、test-strategy |
| R-H2 | 統合・受け入れの CI 実行を U1 の約束にし、「ジョブの本数でなく検証の範囲」とした。実現は案 X・Y で未決。例外の節を揃えた | ADR-001、test-strategy、architecture-infrastructure、non-functional |
| R-H3 | session の表を 7 列に、EV-S04 の `Paused` を ×、Kotlin 版のコードで確かめた条件を表に、`SessionEvents.apply` のスケッチを新設。D3 の `replacementEvents`、受入テスト 5「失効 → 入れ替え → 保存・確定 → 再生」。Kotlin 版の潜在不具合は正本側の整理として未決事項に | domain-model |
| R-H4 | 性質テストを (a) コマンドから作る・(b) 表の ○ の出現・(c) 表 × `apply` の全組の 3 方向に。B1 の表に合否基準 | domain-model、test-strategy、architecture-backend |
| R-H5 | H2 版ロックを `StampedLock` 系 + 上限 + `AfterEnd`（`Tx.run` が `guaranteeCase` で実行）に。`ReentrantReadWriteLock` は不適と明記。「COMMIT の後まで直列化する」条項を両実装の共通に | architecture-backend、data-model、tech-stack、test-strategy |
| R-H6 | `lock_timeout` はロックを取る間だけ設定。55P03 は `Left(RetryExhausted)`、40P01・40001 は `ConcurrencyConflict` に写して再試行。性質 (7)(8) を追加 | architecture-backend、data-model、non-functional、test-strategy |
| R-H7 | `.transact(` の受入条件を 1 つの表に。範囲は `Transactions.scala` 以外の全 `Compile`、テスト本体も落ち `TestTx` だけ除外、文字列・コメントは落ちない。パターンはメソッド名 | architecture-backend、test-strategy、tech-stack、non-functional |
| R-H8 | 依頼文言を「同じ操作が 2 回続けて失敗したら、それ以上操作せず、相関 ID を書き写して運営者に伝える」に。判別は運営者側の監視。相関 ID の消え方（`PlayPage.tsx` 90・166 行）を踏まえ「まず書き写す、そのあと手動更新」の順 | operation、ui-design |
| R-H9 | 控える数字を役割ごとに表にし、コンソールの再読み込み、発注数の記録、復旧後の代理入力と週ごとの確定による追いつき、15 分を待たず紙へ切り替えてよいこと、を追加。**入荷予定は画面にも API にも項目がない**ことを確認し、結果表の出荷・発注と遅延の週数から復元する案にした（足りるかは B1 で確認） | operation、architecture-backend |
| R-H10 | B1 確認項目 (e) の画面文言を削除し、ui-design #15 への参照にした | architecture-backend |

あわせて、中・低の多く（M1〜M17、L1〜L11 の多く）も直した。範囲は各文書の変更記録にある。

### 承認と昇格（2026-11-25、追記）

その後、ユーザーが「D1〜D5 を承認して stable に昇格して」と明示した。

- **D1〜D5 は、ユーザーが承認した決定になった。** ユーザーが承認した決定は 14 件（本人が選んだ 8 件 + ローカル DB の H2 + D1〜D5）。上の表の「AI が推奨案で決めた（確認未了）」は、承認前の記録である。設計書の本文は、承認の記述に直した。
- **D5 で承認したのは手順だけ**で、team 規約の例外そのものの承認と、project.md の `## Scope Overrides` への記録は未実施。
- **設計書 10 本に `verified`（`human:kakimomokuri`、2026-11-25T09:12:07Z）を記録し、`stable` にした。** Rust 版の前例どおり、`index.md`・ADR-001・レビューレポートは昇格していない。ADR-001 のステータスは「提案中（レビュー待ち）」のまま。
- **文書の検証と設計判断の承認は別の記録である。** `stable` の設計書にも、承認していない判断（N-H1・N-H2・N-H3・N-H5 の直し方、SD・SBD・ST1〜ST8・SI・SF・SU・STT・SN・NF-SC、規約の例外、案 X・Y、依頼文言の 15 分など）は未承認のまま残り、設計書の各承認状況の段落に書いてある。

### 反映後も残る未確認・要判断

- **D1〜D5 のユーザーの確認**: 未了。特に D3（失効済みの旧担当者の入れ替え）と D4（H2 版のロック）は設計の中身を決めているので、確認が要る。D5 の project.md への記録は未実施。
- 案 X・Y（統合・受け入れを `check` に含めるか別ジョブか）、`@AC6.1.2` の共有シナリオを足すか、U1〜U3 の AC の一覧を番号まで確定するか、「経路なし」の `request.not_found` への写しは、人の決定待ち。
- 新しい Scala のコード（`Tx.run`、`withShared`、`AfterEnd`、`ReadTx`・`ModeTx`、`SessionEvents.apply`）は**型検査していない**。H2 版のロックの登録簿と `Semaphore` の持ち上げ方、`scalafix:off` の検出（K15）、PostgreSQL のロックの待ち行列は未確認。
- 許す組の表は、Kotlin 版のコードを読んで直したが、AI の案で人の確認がない。
- 「研修 1 回 90〜120 分」は要件文書に出典がなく、「運営者の想定、要確認」と書いた。
- Kotlin 版 ADR の `ReplaceDecision.kt` の潜在不具合、session 図の誤り、ADR-016 の自己矛盾、US6.1・US6.2 の Unit の食い違いは、正本側の整理が要る。
- 反映後の**再々々レビュー**は未実施。指摘が設計の細部から、B1 で型検査と実測をして確かめる事項へ移っているので、B1 の最初のスライドの後に行う選択もある。

## 次のステップ

1. ~~人が D1〜D5 を確認する~~ → 2026-11-25 に承認済み。~~`verified` を記録して `stable` に昇格する~~ → 設計書 10 本は昇格済み。
2. B1 の最初のスライドで、型検査と実測（ロック、`lock_timeout`、`Left` の ROLLBACK、キャンセル）を行う。
3. 承認待ちの判断（規約の例外、案 X・Y、Intent・指標の数値、ST1〜ST8 ほか）を人が決める。
