# 観測性の設計 - U5 u5-results-retention

`observability-requirements.md`（NFR9.1〜NFR9.5）を満たす設計です。構造化ログの形式、要求ごとの識別子、ヘルスチェック、資格情報を出さない許可リストは U1 の `observability-design.md` を、拒否の分類とカウンタは U4 の `observability-design.md` を引き継ぎます。

## 設計

| 要件 | 解決 |
| :--- | :--- |
| NFR9.1 定期処理の結果 | `runOnce` の最後に、`RetentionRunResult` を `retention_run` の 1 行として出す。項目は、`startedAt`、`autoEnded`、`deleted`、`failed`、`skipped`、`durationMs`。ゲームごとには、自動終了のとき `game_auto_ended`（`gameId`、`at`、`reason: "autoEnd"`）、削除のとき `game_deleted`（`gameId`、`at`、`reason: "retentionExpired"`）を出す。項目は許可リスト方式の型で固定し、表示名、ゲーム名、コード、token を渡せない |
| NFR9.2 重大度と連続の失敗 | 1 ゲームの失敗は `game_retention_failed`（`warn`、`gameId`、`operation`: `autoEnd` または `delete`、`errorName`）。全体の失敗は `retention_run_failed`（`error`）。ロックを取れないときは `retention_run`（`info`、`skipped: true`）。連続の失敗の回数は `retention/scheduler.ts` のメモリの数 `consecutiveFailures` で、`runOnce` の結果が失敗（`failed > 0` または全体の失敗）なら 1 増やし、失敗のない成功なら 0 に戻し、skipped なら変えない（増やさず、戻さない）。`consecutiveFailures` が 3 以上になった回は、`retention_run_repeated_failure`（`error`、`consecutive`）を毎回出す。skipped が何回続いても出さない。全インスタンスでの停止の検知は Operation |
| NFR9.3 履歴との関係 | 自動終了は `GameSession.autoEnd` が U3 の `finish` を通して、履歴に `end`（`reason: autoEnd`、`actorKind: system`）を同じ保存の中で足す（既存）。削除は履歴を持つ表ごと消えるため、`game_deleted` のログだけが残る。結果と出力の取得は読み取りで、履歴を足さない |
| NFR9.4 取得のログ | 結果と出力の入口が、応答のあとに `results_served` または `export_served`（`kind`: `results`、`export:csv`、`export:json`、`gameId`、`rows`、`durationMs`）を出す。拒否（403、409、422）は U4 の共通のエラー処理が分類して出す。資格情報は許可リストに無い |
| NFR9.5 警告の仕組みを設けない | 警告の定義、しきい値、通知先を U5 では作らない。カウンタなどのメトリクスは U1 の最小の範囲を超えて新しく作らない。ログ（NFR9.1、NFR9.2）が Operation の材料になる |

## 連続の失敗の回数の遷移

| 直前の回の結果 | `consecutiveFailures` | 出すログ |
| :--- | :--- | :--- |
| 失敗なしの成功 | 0 に戻す | `retention_run`（`info`） |
| ゲームの失敗あり、または全体の失敗 | 1 増やす。3 以上なら `retention_run_repeated_failure` | `retention_run`（`warn` または `error`）、3 以上で `error` を追加 |
| skipped | 変えない | `retention_run`（`info`、`skipped: true`） |

## 上流の資料

`observability-requirements.md`、`rules.md`、`entities.md`、`functional-spec.md`
