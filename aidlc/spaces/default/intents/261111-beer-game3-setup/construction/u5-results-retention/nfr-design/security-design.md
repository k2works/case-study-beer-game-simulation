# セキュリティの設計 - U5 u5-results-retention

`security-requirements.md`（NFR6.1〜NFR6.8、NFR7.1〜NFR7.3）を満たす設計です。コードと token の発行、鍵付きハッシュと暗号化、CSP と HSTS、入口の共通の検証、ログの許可リストは U1 の `security-design.md` を、進行役の操作の認可と投影の専用の型は U3 の `security-design.md` を、資格情報の特定、同一の 403、経路の表と網羅試験は U4 の `security-design.md` を引き継ぎます。

## 設計

| 要件 | 解決 |
| :--- | :--- |
| NFR6.1 結果と出力の認可 | 経路の表（`routeCatalog`）に 2 行を足す。`GET /games/{gameId}/results` は操作 `viewResults`（受け付ける資格情報は、そのゲームの参加者の token と進行役用コード）、`GET /games/{gameId}/export` は操作 `exportGame`（進行役用コードだけ）。認可は U4 と同じく `onRequest` で本文やクエリの検証より前に行う。観察者、無効または期限切れまたは失効した token、無効なコード、別のゲームの資格情報、存在しない（削除済みを含む）ゲームは、U4 の固定の無効な資格情報の応答（403 `forbidden`、同一の本文）にする。判定の順は、認可、`format` の検証（422）、読み取り、状態の検査。終了前の結果は、認可を通った人に 403 `forbidden`（理由は「ゲームが終了するまで、結果は見られません」）を返す。終了前の出力は、進行役に 409 `state`（直し方は「ゲームを終了してから出力してください」）を返す。結果の終了前の拒否は、他役割の値、週の数、確定済みの週の数を応答に含めない。U4 の網羅試験の表に 2 行を足し、資格情報の種類 × ゲームの状態（準備中、進行中、一時停止、終了、削除済み）の全組み合わせを確かめる |
| NFR6.2 含めないもの | 結果は専用の型 `ResultsView`（役割、週、数量、費用だけ）、出力は専用の型 `ExportDocument` と `ExportRecord` を持つ。型に、コード、token、ハッシュ、冪等の識別子、履歴の項目が無い。変換は許可リスト方式（型の項目を 1 つずつ明示して写す。スナップショットの行をそのまま展開しない）。`decidedByDisplayName` は、`decidedByKind` が participant のときだけ、その週の `decidedByParticipantId` に対応する参加者の表示名を、`participants` から引く（入れ替え済みも含む）。試験が、応答の全項目を走査して、コード・token・鍵の値の部分文字列を含まないことを確かめる |
| NFR6.3 出力の応答 | 出力の応答は `Content-Type`（`text/csv; charset=utf-8` または `application/json; charset=utf-8`）、`Content-Disposition: attachment; filename="beer-game-{gameId}.{csv\|json}"`（`gameId` は UUID。ゲーム名や表示名を使わない）、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff` を付ける。結果の応答にも `Cache-Control: no-store` を付ける。CSV は先頭が `=`、`+`、`-`、`@` の値も元のまま出す（`renderCsv` は引用の規則だけを適用し、値を変えない） |
| NFR6.4 ログ | 定期処理と取得のログは、許可リスト方式の項目だけを出す（`retention_run`: 開始時刻、各件数、skipped、所要時間。`game_auto_ended` と `game_deleted`: ゲームの識別子、時刻、理由。`results_served` と `export_served`: 種類、ゲームの識別子、大きさ、所要時間）。ゲーム名、表示名、コード、token、鍵、接続元の生の値は項目に無い。エラーの記録は、エラーの名前と種類だけを出し、メッセージ全体（行の内容を含みうる）を出さない。試験が、ログの行に表示名とコードの値が含まれないことを確かめる |
| NFR6.5 入口 | 定期処理に HTTP の経路を作らない。経路の表に、自動終了・削除・定期処理を起動する行を作らない。U4 の構造の試験（登録された経路のすべてが表にあること）が、経路の追加を検出する。タイマーは `src/server/retention/` にあり、入口のモジュールは Retention を import しない（起動を組み立てる `main.ts` だけが組み合わせる） |
| NFR6.6 設定の検査 | `config.ts` が `RETENTION_DAYS`、`AUTO_END_DAYS`、`RETENTION_JOB_INTERVAL_MINUTES`、`RETENTION_BATCH_LIMIT` を、zod で整数かつ範囲内（`entities.md` の RetentionPolicy）として検査する。範囲の外、小数、空文字以外の非数は `ConfigError` で起動しない。未指定は既定。範囲の中の入力ミスへの守りとして、起動の完了時に有効な設定値を `retention_config` の 1 行（`info`）で出し、`RETENTION_DAYS` または `AUTO_END_DAYS` が既定（30）より短いときは、その旨を `warn`（`retention_config_shorter_than_default`）で出す。大量の削除への守りの残りは、1 回の上限（既定 100 件）と運用手順書の案内（Operation への引き渡し） |
| NFR6.7 判定の入力 | 削除と自動終了の判定は、`clock.now()` と、データベースの `ended_at` と `last_operation_at` だけで行う。要求の本文、ヘッダ、クエリは判定に使わない（定期処理に要求が無い）。削除は `status = 'ended'` を SQL の条件にも含めて二重に守り、進行中のゲームを保持期間では削除しない |
| NFR6.8 表示名の先頭文字 | 表示名の検証は、`session/schemas.ts` の表示名の zod スキーマ（`displayName`）の 1 か所に集める。参加（join）と入れ替え（replace）の両方が同じスキーマを使うことを、試験で確かめる。判定は、保存する値と同じ正規化（前後の空白を取り除く）をしたあとの値に対して、先頭が `=`、`+`、`-`、`@`、タブ、復帰のいずれかなら失敗とする。前後の空白の除去はタブと復帰も取り除くため、正規化後の値の先頭にタブと復帰は現れない。それでも判定の文字の集合に含めておくのは、正規化の定義を将来変えても防ぎが外れないようにする多層の守りである。したがって、入力 ` =1+1`（先頭が空白）や `\t=1` も、正規化後に `=` で始まるため拒否される。拒否は 422 `validation`（理由「表示名の先頭に使えない文字があります」、直し方「= + - @ 以外の文字で始まる名前にしてください」）で、占有の前に行う（U3 の入力検証の順）。画面側は、入力欄の近くに同じ制限を示す。出力の側は、`ExportPanel` に表計算ソフトで開くときの注意を常に表示する（折りたたまない。文言は BR23.9）。画面の試験が、出力ボタンと同時に注意と列名の説明が表示されることを確かめる。すでに保存された表示名は変えない |

## プライバシー（NFR7）

| 要件 | 解決 |
| :--- | :--- |
| NFR7.1 保持と自動終了 | `RetentionPolicy` を値として持ち（`retention/policy.ts`）、`isExpired(endedAt, now, retentionDays)` と `isStale(lastOperationAt, now, autoEndDays)` の 2 つの純粋な関数で判定する（どちらも「以降」の境界で判定する）。設定を変えたときの適用は、毎回の判定で現在の値を使うだけで実現する（ゲームに値を記録しない）。時刻は注入した時計から得る |
| NFR7.2 削除の範囲と痕跡 | 削除は `delete from games where game_id = $1` の 1 文で、外部キーの `on delete cascade`（`game_settings`、`demand_series`、`participants`、`role_assignments`、`week_records`、`pipeline_slots`、`access_codes`、`return_tokens`、`idempotency_records`、`operation_log_entries`）が連鎖して削除する。`week_records.decided_by_participant_id` は連鎖のない参照だが、参照元と参照先が同じ文の中で削除されるため、文の終わりの検査を通る（試験で確かめる）。将来の表が連鎖を持たずにゲームを参照して削除を妨げることを防ぐため、構造の試験が「`games` を参照するすべての外部キーが `on delete cascade` を持つ、またはこの削除で成立することを確かめる一覧に載る」ことを検査する。削除後の確認は、試験が `information_schema` から `game_id` を持つすべての表を引き、行が 0 件であることを確かめる。「削除済み」の表は作らない |
| NFR7.3 ログとバックアップ | U5 は引き渡し事項として Operation に渡す: 構造化ログの接続元の保持期間と、データベースのバックアップの保持期間を、ゲームの保持期間（既定 30 日）を超えない目標で定める。U5 の成果物のログには個人情報を出さない（NFR6.4）ため、ログの保持が個人情報の保持にならない |

## 脅威への対応

| 脅威 | 設計 |
| :--- | :--- |
| 他の人の結果を見る（観察者、別のゲーム、無資格） | NFR6.1。同一の 403。終了前は誰にも返さない |
| 出力に紛れ込む資格情報 | NFR6.2。許可リスト方式の専用の型と全項目の走査の試験 |
| 参加者の表示名による表計算ソフトでの式の実行 | NFR6.8。入口の拒否と出口の注意書き。保存済みの値は注意書きと進行役の操作に任せる |
| 設定の誤りによる大量削除 | NFR6.6。起動時のログと警告、1 回の上限 |
| 管理用の入口への攻撃 | NFR6.5。入口を作らない |
| 削除が一部だけ残る | NFR7.2。1 文の連鎖削除、構造の試験 |

## 上流の資料

`security-requirements.md`、`functional-spec.md`、`rules.md`、`tech-stack-decisions.md`、`contract-summary.md`
