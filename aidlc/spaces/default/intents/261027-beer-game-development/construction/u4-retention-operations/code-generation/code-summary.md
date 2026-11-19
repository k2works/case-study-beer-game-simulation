# Code Summary - U4 Retention Operations

## Implemented

- `RetentionService` に既定 90 日、game 単位の Saga、3 owner の進捗、C5 v2 `attempt` 照合、最大 5 retry、FAILED / manual retry、HMAC receipt、1 年 expiry と restore read gate を実装しました。
- `PostgresRetentionService` は policy、Saga、owner progress、attempt ledger、outbox / inbox、receipt を PostgreSQL transaction に保存します。期限走査は `FOR UPDATE SKIP LOCKED`、C5 は Saga row lock と eventId deduplication を用います。
- `PgOwnerDeletionConsumer` は owner 自身の table を game 単位で削除し、C4 の attempt を C5 v2 に echo します。U1 配送は U2 完了後に待機させ、参加者・session の参照が消える前に U2 の削除を終えます。
- `SqsRetentionWorker` と `SqsOwnerDeletionWorker` を追加し、C4 outbox の SQS publish、C5 consume、v1 / invalid completion の quarantine、ack を実装しました。one-shot worker entrypoint と Terraform の SQS / DLQ、ECS task、EventBridge schedule を追加しました。
- Fastify へ operator credential cookie で認可する retention status / manual retry endpoint と game creation の retentionDays を追加しました。production では HMAC key と DATABASE_URL が欠ける場合に起動を拒否します。
- U4 migration に policy、Saga、progress、attempt、outbox / inbox、receipt、restore gate を追加しました。migration 002 の存在しない `game_sessions` 参照を既存 `sessions` へ修正し、全 migration を専用 PostgreSQL test schema に適用しました。

## Verification

| Check | Result |
|---|---|
| U4 scoped test | 27/27 pass。専用 `beer_game_u4_test` で PostgreSQL migration / transaction / restart / owner deletion / outbox を検証 |
| Full suite | 96/96 pass（変更前 69/69） |
| Coverage | 全体 lines 91.55%、U4 retention lines 89.07%、全体 statements 88.12%、branches 79.10% |
| Format / lint / typecheck | すべて pass |
| Terraform format | `terraform fmt -check` pass |
| Terraform validate | 未実施。ローカル Terraform 1.5.7 は既存 `required_version >= 1.8.0` を満たさず provider も未導入 |

## Remaining gaps and next work

- 本番の AWS SQS / ECS / EventBridge は未 deploy、実 AWS との contract test も未実施です。Terraform 1.8 以上で `init` / `validate` / `plan` と IAM / subnet / endpoint の統合検証を行い、staging で ECS task を実行してください。
- Terraform の worker task へ渡す private subnet、security group、image、Secrets Manager の ARN は環境の platform resource から供給する必要があります。現行 `infra/main.tf` の VPC はこれらの resource をまだ定義していません。
- permanent failure / retry 枯渇の運営 channel 通知を永続 outbox と通知先へ配線していません。5 分以内通知 SLI は未達です。通知先の決定、transactional alert outbox、再送、delivery receipt、escalation を実装して検証してください。
- C5 v2 の共有 `contract-summary.md`、各 Unit の versioned fixture と 1 release window の正式な contract 更新は未完了です。コードは v1 を quarantine し、v2 のみ状態更新します。運用 rollout は契約更新後に実施してください。
- U1 / U2 / U3 の既存 API 本体は in-memory 状態管理を含みます。U4 の PostgreSQL 削除は SQL table を対象にしますが、その既存 API 状態は別途 PostgreSQL に移行する必要があります。現状の production data 削除完了を保証できません。
- PITR restore 後の read gate は DB row に依存するため、restore 開始時に外部 ingress を閉じ、restore 後に `beginRestore` → expiry sweep → `completeRestore` を実行する runbook と外部 gate が必要です。バックアップから `reads_open=true` が復元されるケースを staging で検証してください。
- game creation と U4 policy 保存は別の in-memory / PostgreSQL 操作であり、原子的ではありません。GameService の PostgreSQL 移行時に同一 transaction へ統合してください。

## Sources

- `code-generation-plan.md`
- `functional-design/functional-spec.md`、`rules.md`、`entities.md`
- `nfr-design/reliability-design.md`、`security-design.md`
- `infrastructure-design/infrastructure-specification.md`、`cicd-pipeline.md`

## Assumptions & Open Questions

- C4 の owner 別 queue と C5 v2 completion queue は同一 AWS account / region に配置します。
- notification channel と契約 v2 の正式な併存終了日が未定です。
