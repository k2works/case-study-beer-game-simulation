# Infrastructure Design Questions - U4 Retention Operations

## Q1. 削除 worker の実行基盤

既存の TypeScript / Fastify application と SQS owner queue に接続する U4 worker をどこで動かしますか。

- A. 既存 application と同じ ECS Fargate の別 service とし、queue ごとに scale する
- B. owner queue ごとの AWS Lambda とする
- C. 既存 application process に worker を同居させる
- X. Other (please specify)

[Answer]: A

## Q2. Receipt の復旧後保持制御

PITR 復旧時に削除期限を過ぎた receipt が再び見えることを防ぐ方式を選んでください。

- A. 復旧中は receipt 読取を閉じ、期限切れ sweep を完了してから再開する
- B. 期限切れ receipt の tombstone を別の独立 store に保持して照合する
- C. receipt を PostgreSQL から切り離し、期限付き object store に置く
- X. Other (please specify)

[Answer]: A

## Q3. U4 の production rollout

C5 に必須の `attempt` を追加する major change について、どの公開手順にしますか。

- A. v2 consumer と v1 quarantine を先行配置し、producer を v2 に切替後、1 release window 併存する
- B. U1 / U2 / U3 / U4 を同時に一括切替する
- C. maintenance window 中に v1 を停止し、v2 だけを起動する
- X. Other (please specify)

[Answer]: A

## Sources

- `nfr-design/security-design.md`
- `nfr-design/reliability-design.md`
- `nfr-design/reviews/review-01.md`
- `inception/contract-design/contract-summary.md`

## Assumptions & Open Questions

- U4 worker は ECS Fargate の別 service、owner queue ごとの scaling を採用します。
- PITR 復旧後は receipt 読取を閉じ、期限切れ sweep を完了してから再開します。
- C5 は v2 consumer と v1 quarantine を先行配置し、producer 切替後、1 release window 併存します。
