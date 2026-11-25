---
type: Review
title: "設計書レビュー - beer-game-scala（2026-11-25）"
description: "beer-game-scala の設計書 10 本と ADR-001 を、プロダクトマネージャー・アーキテクト・インタラクションデザイナー・テスター・ユーザー代表の 5 視点で並列にレビューした統合結果。重複を除いて重要度「高」10 件、「中」17 件、「低」11 件。対応方針は案で、人が確定する。"
tags: [review]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-25T08:00:00Z }
---

# 設計書レビュー - beer-game-scala（2026-11-25）

## レビュー対象

- `docs/design/beer-game-scala/` の設計書 10 本と `index.md`、[ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md)。
- 状況は `draft`。実装コードは存在しない。承認済みの設計判断はなく、ユーザーの決定は「ローカル DB は H2」（2026-11-25）の 1 件だけ。
- 5 視点とも**読み取り専用**で実施した。精読の範囲は視点ごとに異なる。プロダクトは ADR-001・index・domain-model・data-model を重点に、UX は ui-design と architecture-frontend に絞り実物の `apps/beer-game-web` まで確認した。ガイド（Scala 編）の本文を読んだのはアーキテクトだけ。エージェントの出力は**モデルの出力**であり、ユーザーの承認ではない。

## 事実確認の結果（統合時に自分で確認した主な指摘）

| 指摘 | 結果 |
| :--- | :--- |
| 同じ事項の「確認済み／未確認」が文書ごとに逆（AR、TS） | **確認済み**。`architecture-backend.md` 216・238 行は「`Left` で COMMIT する挙動は実 DB では確認していません」、`data-model.md` の検証 A-2 は「`Left` でも COMMIT する。`FC.rollback` を挟むと残らない」を確認済みとする |
| 開始後の入れ替えをドメインの遷移で扱っていない（UR） | **確認済み**。`domain-model.md` で `RoleAssigned` を受けるのは `Preparing` だけ（236 行）で、`ParticipantReplaced` は出てこない。Kotlin 版は 427 行で `Started` の自己遷移に `ParticipantReplaced` と `RoleAssigned` を含める |
| `DB_KIND` の記述が文書間で食い違う（UX） | **確認済み**。`architecture-frontend.md` 177 行は「`DB_KIND` は持たない」、`architecture-infrastructure.md` 171 行は `DB_KIND=postgres\|h2` を使う |
| H2 の拒否の検査が Kotlin 版より弱い（AR） | **確認済み**。Kotlin 版（infrastructure 173 行）は `DB_KIND=h2` に加えて JDBC URL `jdbc:h2:` も拒否する。Scala 版は `DB_KIND` だけ |
| Kotlin 版のイベント表で EV-S07 と EV-S10 が同じ `SetCommitMode` を発生条件にしている（AR） | **確認済み**（Kotlin 版 776・780 行）。正本側の問題で、Scala 版は未決として引き継ぐ必要がある |
| SIGTERM の終了コードの扱い（UR、TS） | **一部確認**。`operation.md` 314 行は「Scala 版での値は未確認」。NF-SC1 側の「終了コード 0」の記述は、2 視点の指摘のまま未再確認 |
| 2.86 秒は実測でなく推定（UX） | 指摘どおり。UX が `docs/development/beer-game-rust/nfr_results.md` の注記を確認済み。Scala 版の文書の「実測」は誤り |

## 総合評価

正本（Kotlin 版）の構造は、判断 D・BD・T・データモデルの判断、EV-G/EV-S の範囲で漏れなく引き継げている。承認の扱いも誠実で、AI の案とユーザーの決定が分かれており、AI が「承認済み」と書いた箇所は見つからなかった。確認した事項と未確認の事項を分ける姿勢も、実測（`Left` での COMMIT など）に裏づけられている。

一方で、承認ゲートにかける前に直すべき問題が 3 群ある。(1) **確認状況の食い違い**（先に書いた文書が古いまま）。(2) **設計の穴**: 開始後の入れ替えの遷移、`Tx.rollbackOnLeft` が `FC.rollback` の後の書き込みを防げない点、ポート型が H2 版に合わない点。(3) **意思決定の材料の不足**: Intent・成功の測り方・範囲が ADR-001 にない、カバレッジ案 A の論理が成り立たない、NF-P2 の選択肢が「画面は変えない」と両立しない。

## 改善提案（重要度順）

対応方針の欄は**案**で、人が確定する。

### 高

| # | 提案 | 指摘元 | 理由 | 対応方針（案） |
|---|------|--------|------|----------------|
| H1 | 確認状況を 1 つの表に集め、全文書をそれに揃える。先に書いた `architecture-backend`・`operation`・`tech-stack`・ADR-001・`index` を直す。ADR の `HC.rollback` は `FC.rollback` | AR、TS | 前提が成り立たなければ SBD2〜SBD4 を見直す条件があるため、状態が文書ごとに違うと承認の判断がぶれる | 修正する（data-model と test-strategy を正とする） |
| H2 | 開始後の入れ替えを `Started` の遷移として設計する（`RoleAssigned`・`ParticipantReplaced`・`CredentialRevoked`・`RoleHolderReplaced`）。「入れ替え後も保存・確定できる」受入テストを足す | UR | `Ignored` で 500 にする設計と合わせると、研修中に担当者を入れ替えたゲームが操作不能になる。Kotlin 版は変更表 38 で直した | 修正する |
| H3 | `Ignored` で止める扱いを、Kotlin 版（状態を変えず記録して続行）からの**利用者に見える変更**として変更表と index に載せる。障害パターン 17 の初動に、進行役への依頼文言、研修中の原則（該当ゲームだけを止め、手順 A の DB 全体の復元を研修時間に行わない）、他ゲームへの影響を書く | UR | 研修が止まる。手順 A は同時進行の最大 15 ゲームの直近の確定も巻き戻す | 修正する。止めるか続行するかは**人が決める**（下の論点 1） |
| H4 | `Tx` の公開を、ROLLBACK と `transact` を一体にした `Tx.run(program)` だけにし、コマンドの `ConnectionIO` 全体（ロック → 認証 → 冪等記録 → step → 投影 → 周辺ストア → 通知 → 冪等記録の保存）を包む。`.transact(` の直接の呼び出しを Scalafix の `DisableSyntax.regex` で禁止し、「`Tx` を通さない `.transact` を置くと CI が落ちる」を最初のビルドの受入条件に入れる | AR、TS | `FC.rollback` の後に同じ `ConnectionIO` で書き込みが続くと新しいトランザクションとして COMMIT される。NF-SC2 の検査方式が test-strategy のどこにもない | 修正する |
| H5 | `ProjectionLock` と `ChangeNotifier` の型を、H2 版にも合う形に決める。ロックは `transact` の外の `Resource[IO, Unit]`、通知は「トランザクション内で集め、`transact` の後に `IO` で配信（PostgreSQL 版は中で `pg_notify`）」とし、`execute` の戻り値に通知の列を持たせる | AR | H2 版の「プロセス内ロック」「コミット後に配信」は `ConnectionIO` の中では表せない。両実装で同じ契約テストを流すには型が同じである必要がある | 修正する（B1 の最初に実測してから確定） |
| H6 | カバレッジ案 A（「文 85% なら行 80% を満たすとみなす」）に、反例（9 文の行 1 行だけ実行で文 90%・行 50%）を書き、「実測で関係を確かめるまで floor を満たしたと言わない」とする。案 C に「scoverage の XML の文の行番号から行率を算出」を加え、Rust 版が行 80% をそのまま承認済みのゲートにした先例（RT3）を比較に入れる | TS（AR も承認の明示を要望） | org.md の規約は coverage floor を弱めて通してはならない。指標の置き換えには根拠が要る | 修正する。採否は**人が決める** |
| H7 | ADR-001 に Intent（誰のための価値か）、成功の測り方（数値目標つき。案は test-strategy 433 行目にある）、範囲と「やらないこと」（U1〜U3 を最初の約束とし、U4〜U6・専用 AWS 環境・CI の新設は指標を見て決める）を足す | PM | 機能はエンドユーザーに変わらず、価値は事例・参照実装としてのもの。Rust 版は release_plan で Intent と指標の目標の承認を得ている | 修正する。範囲は**人が決める** |
| H8 | ADR-001 の引き継ぎ表を、Kotlin 版 ADR 002〜020 の**本文**で検証する | PM | 現状は Rust 版 ADR-001 の表と各 ADR のステータス節を根拠にした孫引きで、ADR-001 自身の「本文を読んで確認すること」の条件を満たしていない。Rust 版は本文の検証で 4 件の判定を直した | 修正する |
| H9 | NF-P2 を p95 4 秒（Rust 版と同じ）に揃える案を第一とする。SSE で 2 秒を保つ選択は、共有の画面の変更であり「画面は変えない」（SU2・SF1）と両立しないため、全実装に共通の画面の改善として扱う。監視の閾値（operation の Critical 2 秒）と NF-P4（1 秒間隔のポーリング）も揃える | UX、UR、PM、TS | 画面のポーリング間隔は画面の定数で、バックエンドが変えられるのは GET の所要だけ。実装ごとに目標が違うと運営者への説明が成り立たない | **人が決める**（要件の正本の問題として扱う） |
| H10 | `ui-design` #12 と `architecture-frontend` のポーリングの範囲を実際の画面に合わせる（Play・Lobby・Observation が各 3 秒、console にはない。失敗の扱いも Lobby は 403 だけ表示して取り直しをやめる）。「Kotlin 版・Rust 版の実測」を「Rust 版の推定（GET の実測 + 3 秒間隔からの計算）」に直す | UX | 事実と違う記述。レート制限の対象外にする GET の範囲もこれで決まる | 修正する |

### 中

| # | 提案 | 指摘元 | 理由 |
|---|------|--------|------|
| M1 | `Ports[E]` を `gameStore`・`sessionStore` を持つ型にし、書き込み・読み取り・観察者の `Transactor` を型で区別する | AR | `StartGame` や開始後の入れ替えは 2 ストリームに書く。観察者の分離（NF-S18）は配線の誤りに弱い |
| M2 | 一意制約違反（23505）の後は、その `ConnectionIO` で次の文を発行しない規則（SAVEPOINT を使う場合を除く）を契約に書き、PostgreSQL の統合テストで確かめる | AR | PostgreSQL は 25P02 で中断するが H2 は中断しないため、ローカルでだけ通るコードが書ける |
| M3 | SBD3 案 A の費用（インメモリ実装も `ConnectionIO` を返し `Transactor` が要る）を評価表に足し、案 B（自前の `Tx[A]`）と比べる | AR | トレードオフの表がこの費用に触れていない |
| M4 | H2 の拒否に、`DB_KIND=h2` に加えて JDBC URL `jdbc:h2:` の検査を引き継ぐ。H2 では 2 つ目のプロセスを拒否する手段（ファイルロックなど）を検討する | AR | Kotlin 版より弱い。H2 のロックと通知は単一プロセスでしか有効でない |
| M5 | Kotlin 版のイベント表の EV-S07 `AutoCommitChanged` と EV-S10 `CommitModeChanged` の重複を、未決事項として引き継ぐ（どちらを採るか） | AR | 同じ `SetCommitMode` を発生条件にしている。`GameOverview` の投影が `AutoCommitChanged` を購読する |
| M6 | SD2（`State.version` から `Evolution` へ）と SD7（`Long`）を、ADR-001 の「Scala 固有の判断」表に足す | PM | 正本の設計を変える判断が ADR を経ないと、ADR-001 の「どれが変わったかが 1 か所で分かる」が崩れる |
| M7 | `domain-model` に US・AC への導線（US → コマンド → イベントの短い表、または Kotlin 版の該当節へのリンク）を足し、Unit 定義の U1 の範囲と B1 の許可リストの対応を示す | PM | Kotlin 版は US・AC への言及が 20 件、Scala 版は 2 件。パリティの指標が測れなくなる |
| M8 | `data-model` 未決事項 7（`session_overview.week` が最終週 + 1 になる）を、Kotlin 版と共同で決める項目にする | PM | 案 A は共有するイベントの契約を変える。Scala 版だけで決めると正本との乖離になる |
| M9 | `handle` が作る列が `Ignored` にならない性質のテストに、「全イベントの種類が 1 回の実行で N 回以上生成される」を `collect` で検査して足す | TS | 最後の腕が `_` で、守りはこの性質テストだけ。作れないイベントの種類の腕の漏れを見逃す |
| M10 | 再試行の上限（`maxAttempts`）が試行回数か再試行回数かを 1 つに決め、境界値のテスト（上限 − 1 回目の競合のあとに成功／上限ちょうどで `RetryExhausted`）にする | TS | `execute` のスケッチは総試行が `maxAttempts` 回で、NF-R17 の定義がどこにもない |
| M11 | H2 版の契約テストを `EventStore` の追記の競合と `payload` の往復にも広げ、契約の条項を「両実装に共通」と「PostgreSQL だけ」に分けて列挙する | TS | 制約名の取り出しと `json` の書き込みは H2 版独自のコードで、どの層のテストにも入っていない |
| M12 | NF-SC1 の SIGTERM の終了コード（要件の 0 か、未決か）を揃え、「一定時間」の決め方（例: `lock_timeout` 未満、または p99 で X 秒以下）を書く | TS、UR | operation 314 行は未確認。決め方がないと B1 で合否を判定できない |
| M13 | スタブ `Connection` の検証を、呼び出し順の完全一致（`setAutoCommit, rollback, commit`）にしない。「`Left` の経路で `rollback` が呼ばれ、それより前に書き込みが commit されない」「成功で `rollback` が呼ばれない」に絞る | TS | 順序は doobie の Strategy の内部実装で、RC 版の更新で変わりうる |
| M14 | キャンセル安全性のテストは、固定の待ちでなく期限つきで条件を繰り返し確かめる補助関数（`eventually`）を用意し、夜間のジョブで不安定さの割合を記録する | TS | `Thread.sleep` は禁止で、`TestControl` は実 DB の時間に効かない |
| M15 | `ui-design` の #8（相関 ID は本文の `correlationId`、`code: app.internal`）、#1（JSON でない 5xx は `type` なしと判断され同じキーで最大 2 回自動再送されること）、#9（画面は `Retry-After` を読まない。契約の要求）、#13（誤り 0 件の 422 の見え方と `field` の名前の形）を直す。`architecture-frontend` の SF2 の自己矛盾（RF3 は承認済みだが `hooks.mjs` は未対応）を直す | UX | 実際の画面のソースと食い違う |
| M16 | ポーリング失敗の無言をなくす（数回続けて失敗したら最終更新の時刻と「接続を確認しています」を示す）ことを、全実装に共通の画面の課題として優先度を上げ、ストーリー化する | UR、UX | 参加者は「待っている」のか「画面が止まっている」のかを区別できない。WCAG 4.1.3 にも関わる |
| M17 | `architecture-frontend` と `architecture-infrastructure` の `DB_KIND` の記述を揃える | UX | `hooks.mjs` の起動案内の文言に直接効く |

### 低

| # | 提案 | 指摘元 |
|---|------|--------|
| L1 | ADR-001 の判断 ID の接頭辞の規則に SI・SF・SU・STT・SN を追記する。SBD7 と ST6（circe）、SBD11 と ST8（HikariTransactor）の重複は正本を 1 つにする | AR |
| L2 | backend の層の表の `app` のモードに `verify-projections` を足す | AR |
| L3 | `PersistenceFailure`（Kotlin 版の名前）が backend 403 行と data-model 373 行に残る。`AppFailure.Persistence` に直す | AR |
| L4 | ガイド引用の精度: domain-model 33 行は §4.4 でなく §4.3、ADR-001 のトレース表の §3.4 の「全件を集める」は §6.3、`handle(state, command)` はガイド §7.6 の `handle(command, state)` と引数順が違う | AR |
| L5 | tech-stack ST4 の「テストには WartRemover を適用しない」に、実際の設定（`Test / scalacOptions` から `-P:wartremover` を除く）を書く。ST4 の「設定名は要確認」も確認済みに直す | AR、TS |
| L6 | `AssignRole` の判定順を「権限 → 準備中か」にし、権限のない人に状態を知らせない（Kotlin 版の原則） | UR |
| L7 | ゲーム作成の二重送信（`ui-design` #11）を未決事項の一覧に入れる | UR |
| L8 | golden の期待値を Gherkin のようにデータファイルとして共有し、3 実装で同じ値を検証する。`Units`・`Money` が `Long` で桁あふれしない境界テストを足す | TS |
| L9 | 非機能のテストの対応表を、Scala 版で ID ごとに 1 つにまとめる（現状は Kotlin 版の表との差分読み）。テストの形の割合 65/30/5 の測り方を決める | TS |
| L10 | `ui-design` の「基準にした版」に、Kotlin 版の `ui-design` の既知の食い違い（376 行付近の停止・再開の知り方、667 行付近の「1 秒ごと」。実装は 3 秒のポーリング）を注記する。`missingRoles` を、バックエンドが満たす本文の項目に加える | UX |
| L11 | index に承認待ちの判断を 1 つの表にして、承認者・時期を足す。ADR-001 の `NF-SC` の「変更するなら人が決める」に「（未承認）」を付ける | PM |

## 矛盾事項

指摘が正面から相反するものはなかった。次は人の判断が要る論点である。

| # | 視点 A | 視点 B | 論点 | 推奨判断 |
|---|--------|--------|------|----------|
| 1 | AR の SBD・ADR-001: 不正な遷移（`Ignored`）は安全側に倒して操作を止める | UR: Kotlin 版は記録して続行する。止めると研修が止まる | 正しさと研修の継続のどちらを優先するか | 止める設計を維持し、H2・H3 を満たしたうえで、研修中の運用（該当ゲームだけを止める、手元でのメモ）を定義する。決定は人 |
| 2 | PM: 範囲を U1〜U3 に絞り、U4〜U6 は後に回す | ADR-001・index: 範囲は U1〜U6 | 第 3 の実装に同じ運用基盤を持つ費用対効果 | 最初の約束を U1〜U3 とし、残りは指標を見て決める。決定は人 |
| 3 | TS: カバレッジの代替は反例があり成り立たない | ST4・STT2: 文 85%・分岐 75% を暫定とする | team の「行 80% floor」を守るか、代替の根拠を示すか | H6 のとおり、実測で関係を確かめるか、行率を算出する案 C を採る。決定は人 |

## 懸念事項（複数視点）

- **未確認の前提が中心に集中している**: キャンセル時の ROLLBACK、`Supervisor` の追跡、ember の切断時の挙動、同じ `Idempotency-Key` の実行中の再送の待ち方。これらは SBD2〜SBD4 と「結果が不明」の体験を支えるため、B1 の最初のスライドで、切断・再送・SIGTERM の 3 つをシステムレベルのテストにすることを計画に入れる（AR、TS、UX）。
- **正本側が未承認の連鎖**: Kotlin 版 ADR 003〜011・013・014 は「提案中」で、Scala 版の「引き継ぐ」の多くは未承認の判断の上にある。Scala 版の承認が、Kotlin 版の未承認の判断を暗黙に承認したことにならないよう、承認の範囲を書く（PM、AR）。
- **3 実装の追従の費用**: 正本の変更を Rust 版・Scala 版へ追従させる仕組みが「変更は正本側で行い追従する」の 1 文だけ。共有 `.feature` の通過率を CI で比べるなどの仕組みが要る（PM）。
- **ライブラリの成熟度**: doobie は RC12（ガイドの RC13 は Maven Central にない）、http4s は 0.23 系。更新のたびに SBD2〜SBD4 の前提（`Left` の ROLLBACK、キャンセル）を再確認する回帰テストを CI に置くことが前提（PM、AR）。
- **H2 のローカル決定の範囲**: H2 版で守られない 7 制約（追記専用、観察者のロールの分離 NF-S18 など）を、ユーザーが承知のうえで決めたかは文書から確認できない。承認時に 7 項目を示して確かめる（PM）。
- **進行役向けの「研修中にシステムが止まったら」の案内がない**: 運用手順書は運用担当向けのみ。`Ignored` で止める障害が増えるため、進行役が手元で取る行動を 1 枚にまとめた案内の必要性が高い（UR）。
- **RTO 15 分が PITR で収まる保証がない**: Kotlin 版から引き継いだ矛盾で、運営者と SLO を合意する前に解消が要る（UR）。

## スコープ外の発見

- `apps/beer-game-web/package.json` の `description` が「ビールゲーム（Kotlin 版）の画面」のまま（UX）。
- Rust 版の文書の内部で、2.86 秒を `ui-design` #12 は「実測」、`architecture-frontend` は「推定」と書く（UX）。
- `docs/development/beer-game-scala/` が存在しない。設計の承認の後に、Intent・Unit・Bolt の計画（`planning-releases`）が必要（PM）。
- Kotlin 版の ADR 004〜011・013・014 が「提案中」のまま（PM、AR）。
- Kotlin 版 `domain-model` の EV-S07 と EV-S10 の重複は、正本側の整理が要る（AR）。

## エージェント別の件数

| エージェント | 高 | 中 | 低 |
| :--- | ---: | ---: | ---: |
| xp-product-manager | 3 | 4 | 2 |
| xp-architect | 3 | 5 | 5 |
| xp-interaction-designer | 3 | 5 | 2 |
| xp-tester | 3 | 6 | 3 |
| xp-user-representative | 3 | 2 | 2 |

上の表は指摘の重複を除いた統合後の番号で、エージェント別の件数は元の指摘数である。各エージェントの全文はこの文書に転記していない。根拠となる文書名・節・行は、上の表の「理由」と事実確認の結果に残した。

## 対応状況（2026-11-25）

重要度「高」の 10 件を設計文書へ反映した。**ユーザーの決定は 4 件だけ**で、他は AI の案であり承認を得ていない。

| # | 対応 | 決定の区分 | 主な反映先 |
|---|------|------------|------------|
| H1 | 確認状況の一覧（K1〜K23）を新設し、各文書の食い違いを事実に直してリンクにした | AI の案 | tech-stack の「確認状況の一覧」、architecture-backend、operation、ADR-001 |
| H2 | `Started` の自己遷移（`RoleAssigned`・`ParticipantReplaced`・`CredentialRevoked`）、`RoleHolderReplaced` は session の `Active`・`Paused` の自己遷移とし、受入テストと性質テストの生成器に入れ替えを加えた | AI の案 | domain-model、test-strategy |
| H3 | `Ignored` で止める設計を維持。利用者に見える変更として変更表に載せ、障害パターン 17 の初動と新パターン 18、ui-design #15 を足した | **ユーザーの決定** | domain-model、operation、ui-design、ADR-001、index |
| H4 | `Tx.run` を唯一の公開入口にし、`.transact(` を Scalafix で禁止。旧案の合成子は不採用 | AI の案 | architecture-backend、tech-stack ST4、test-strategy、non-functional |
| H5 | `ProjectionLock` を `Resource[IO, Unit]`、`ChangeNotifier` を集めて `Tx.run` の後に配信する型に変更 | AI の案（B1 の最初に実測して確定） | architecture-backend、data-model、test-strategy |
| H6 | 行率を XML から算出する案 C を第一にし、案 A に反例を書いた。文 85%・分岐 75% は暫定の追加ゲート | **ユーザーの決定**（案 C を第一） | tech-stack ST4、test-strategy、non-functional、ADR-001 |
| H7 | ADR-001 に Intent（案）・成功の測り方（数値は B1 で承認を得る案）・範囲の表を追加。U1〜U3 を約束、U4〜U6・専用 AWS 環境・CI の新設は指標を見て決める | **ユーザーの決定**（範囲）。Intent の文面は案 | ADR-001、index |
| H8 | 引き継ぎ表を Kotlin ADR 002〜020 の本文で検証した。判定ラベルは 20 行とも変わらず、内容と根拠を直した | AI の案 | ADR-001 |
| H9 | NF-P2 を p95 4 秒に再定義。NF-P4、NF-O4、監視の閾値（Warning 3 秒・Critical 4 秒）も揃えた。SSE の 2 秒は全実装共通の画面の改善として別扱い | **ユーザーの決定** | non-functional、operation、ui-design、architecture-frontend |
| H10 | ポーリングの範囲を実際の画面に合わせ、2.86 秒を「Rust 版の推定」に直した | AI の案 | ui-design、architecture-frontend |

あわせて、中・低の一部（M1〜M4、M9〜M15、M17、L1〜L6、L8〜L11）も直した。M5〜M8、M16 の「ストーリー化」、L7 は未対応で、各文書の未決事項に残る。

**訂正（再レビューでの指摘）**: 上の記述は不正確だった。M6（SD2・SD7 を ADR-001 の「Scala 固有の判断」表に足す）は実際には対応済みだった。M5（EV-S07 と EV-S10 の重複）と M7（US・AC への導線）は、当時どの未決事項にも載っていなかった。いずれも再レビューの対応（[設計書の再レビュー](./design_rereview_20261125.md) の M20）で、domain-model の未決事項に載せた。

### 反映後も残る未確認・要判断

- 新しく書いた Scala のコード（`Tx.run`、`Committed`、`Ports` など）は**型検査していない**。`FC.rollback` の後の書き込みの扱い、`transact` の外のアドバイザリロック、専用接続の `LISTEN`、キャンセルと `Supervisor`、`IOApp` の SIGTERM の終了コードは未確認。
- 日本語見出しのアンカー（`#確認状況の一覧` など）は、`mkdocs.yml` の `toc` が slugify を設定していないため、公開サイトで解決するか未確認。ソース上は見出しと一致している。
- 行率を scoverage の XML から出せるかは B1 で確かめる。出せなければ、文の率で代替してよいかを人が再度決める。
- Intent の文面、成功の測り方の数値目標、H1・H2・H4・H5・H8・H10 の直し方は、人の承認が要る。
- 設計文書への反映後の**再レビュー**は未実施。`verified` の記録と `stable` への昇格は人が行う。

## 次のステップ

1. 反映した設計文書を人が確認する。
2. 再レビューを実施する。
3. 人が `verified` を記録して `stable` に昇格する。
