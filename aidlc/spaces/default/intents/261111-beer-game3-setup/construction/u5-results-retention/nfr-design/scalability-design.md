# 拡張性の設計 - U5 u5-results-retention

`scalability-requirements.md`（NFR4.1〜NFR4.5）を満たす設計です。単一のアプリケーションと PostgreSQL の構成、ゲーム単位の直列処理、占有しない読み取りは U1 の `scalability-design.md` を、複数のアプリケーションでも成り立つ作りは U4 の `scalability-design.md` を引き継ぎます。

## 設計

| 要件 | 解決 |
| :--- | :--- |
| NFR4.1 規模と削除の遅れ | 定期処理は `RETENTION_JOB_INTERVAL_MINUTES`（既定 60）ごとに 1 回、自動終了と削除をそれぞれ最大 `RETENTION_BATCH_LIMIT`（既定 100）件選ぶ。1 日あたりの処理能力は、24 周期 × 100 件 = 2400 件（削除）で、見込みの 100 件／日を大きく上回る。対象を選ぶ問い合わせは、部分索引を使う（下の索引）。期限を過ぎてから削除されるまでの遅れは、通常 1 周期以内。保持期間を短くした直後に対象が 2400 件を超える分は、1 周期 100 件ずつ処理するため、超えた件数に応じて延びる |
| NFR4.2 二重実行の防止 | `Store.runExclusive(key, fn)`（PostgreSQL の保存）が、接続プールから専用の接続を 1 本借り、`select pg_try_advisory_lock($1::bigint)` を試みる。取れなければ `fn` を呼ばず `{ acquired: false }` を返す（待たない。skipped）。取れたら `fn` を呼び、`finally` で同じ接続で `pg_advisory_unlock` し、接続を戻す。解放に失敗したら、その接続を破棄して戻す（`release(true)`）ため、ロックは接続の終了とともに解放される。ロックの鍵は定数（`retention-job` の名前から導いた 64 ビットの整数）で、U4 の接続元ごとのトランザクションのロック（`pg_advisory_xact_lock` の別の鍵の空間）と衝突しない。メモリ上の保存は、同じプロセスの実行中の印で二重実行を防ぐ。処理の本体のゲームごとのトランザクションは、このロックを保持する専用の接続とは別のプールの接続で行う（ロックの接続はロックを保つためだけに使い、ゲームの処理に使わない） |
| NFR4.3 読み取りは待たない | 結果と出力は `readSnapshot`（`REPEATABLE READ READ ONLY`）で読み、ゲームの行を占有しない。終了したゲームには書き込みがないため、読み取りは書き込みと競合しない。削除との重なりの扱いは `reliability-design.md` の NFR2.3 |
| NFR4.4 設定値 | `retention/policy.ts` の `loadRetentionPolicy(env)` が範囲つきで読み込み、既定を持つ（`security-design.md` の NFR6.6）。値の変更は環境変数と再起動で行う |
| NFR4.5 出力の大きさ | 行数は週数 × 4 役割で上限があり、CSV と JSON はメモリ上で組み立てる。ストリームの仕組みは要らない（約 30 キロバイト）。出力の大きさを 50 週のゲームで測って記録する試験を置く |

## 索引と移行

`1763200000000_u5-results-retention.sql` で次を行う（別の移行。既存の列を変えない）。

```
alter table games add column last_operation_at timestamptz not null default now();
update games g set last_operation_at = greatest(
  g.created_at, coalesce(g.ended_at, g.created_at),
  coalesce((select max(occurred_at) from operation_log_entries where game_id = g.game_id), g.created_at),
  coalesce((select max(joined_at) from participants where game_id = g.game_id), g.created_at),
  coalesce((select max(decided_at) from week_records where game_id = g.game_id), g.created_at));
create index games_stale_idx on games (last_operation_at) where status <> 'ended';
create index games_expired_idx on games (ended_at) where status = 'ended';
```

- 部分索引にするのは、蓄積した終了済みのゲーム（最大 3000 件前後）の中から、期限を過ぎたものを選ぶ問い合わせと、未終了のゲームの中から放置されたものを選ぶ問い合わせが、それぞれ自分の集合だけを走査できるようにするため。
- 移行の補完は、`entities.md` の制約のとおり、履歴・参加・入力のうち最も遅い時刻で埋める。これにより、移行の直後に早すぎる自動終了は起きない。試験は、参加者の入力だけが進んだ既存のゲームを移行して、自動終了の対象にならないことを確かめる。
- 列には `default now()` を付けたままにする。ローリングデプロイの間に旧版のアプリケーションが `games` へ挿入しても、`not null` で失敗せず、作成時の時刻が入る（最後の操作の時刻の既定として意味が変わらない）。新版は作成時に `created_at` と同じ値を明示して入れる。

## 上流の資料

`scalability-requirements.md`、`functional-spec.md`、`rules.md`、`entities.md`、`tech-stack-decisions.md`
