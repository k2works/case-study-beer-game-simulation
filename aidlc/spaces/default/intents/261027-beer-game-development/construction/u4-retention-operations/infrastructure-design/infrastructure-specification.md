# Infrastructure Specification - U4 Retention Operations

## Deployment

| Facet | Choice | Rationale |
|---|---|---|
| Compute model | 既存 Fastify API と、U4 専用 ECS Fargate scheduler / dispatcher / owner completion worker を別 service として配置 | API と期限削除の負荷、失敗、deployment を分離する。owner queue ごとに worker 数を調整する |
| Networking | 既存 ALB のみ public、ECS と RDS は 2 AZ の private subnet、SQS / EventBridge / KMS / Secrets Manager へ VPC endpoint 経由 | database と worker に直接 public ingress を作らない |
| Storage | 既存 RDS PostgreSQL に U4 専有 schema と outbox / inbox / saga / receipt table、PITR 7 日 | state と receipt の transaction を一体化し、復旧点を持つ |
| Environments | 同じ Terraform module を dev / staging / production に適用し、scale parameter のみ環境別 | topology 差による障害を避ける。production は Multi-AZ、staging で同じ機能を検証する |
| IaC | 既存 Terraform state / pipeline に U4 module を追加 | 既存運用の変更経路と drift detection を維持する |
| Resource sizing | API は既存 service、U4 worker は 0.5 vCPU / 1 GiB、owner queue あたり 1〜5 task を初期値とし load test で確定 | 23 concurrent due game を対象に、task あたり concurrency 1、各 owner 1 message / 30 秒なら 5 task で 10 件 / 分を処理する。23 game × 3 owner は約 7 分で掃け、24 時間 SLO に余裕がある |

## Infrastructure Services

| Service | Role | Configuration | Notes |
|---|---|---|---|
| RDS PostgreSQL | database | production Multi-AZ、KMS 暗号化、PITR 7 日、private security group、U4 専有 schema | receipt expiry は `created_at + 1 year`。復旧点が 7 日以内でも期限切れ receipt が復活し得るため restore 後の sweep が必須 |
| SQS standard × 3 + DLQ × 3 | queue | owner Unit ごとの request queue、KMS 暗号化、visibility timeout は worker timeout より長く設定、redrive policy | C4 は at-least-once。U4 は C5 completion queue を別に持ち、eventId inbox と attempt で冪等化する |
| SQS completion + DLQ | queue | v2 channel 専用、KMS、schemaVersion と attempt の境界検証 | v1 は隔離 queue に routing し、状態遷移へ入力しない |
| EventBridge Scheduler | scheduling | 5 分ごとに due scan、別 rule で receipt cleanup と復旧後 sweep | 重複 invocation は DB lock / unique active saga で抑制する |
| KMS + Secrets Manager | key / secret | service ごとに least-privilege grant、HMAC key version と rotation | credentials と key material は image / code / log に載せない |
| CloudWatch + OpenTelemetry collector | metrics / logs / traces | low-cardinality label、error / terminal event は sampling しない | log と trace の禁止 field scan を CI で実施する |

## Shared Infrastructure

| Shared Resource | Owner Unit | Consumer Units | Access Boundary |
|---|---|---|---|
| RDS cluster / VPC / ALB | U1 platform baseline | U1、U2、U3、U4 | U4 schema と scoped DB role。U4 から owner table の直接削除を禁止する |
| C4 / C5 event contracts | U4 | U1、U2、U3 | versioned channel と contract test。owner ごとの request queue と completion queue を使用する |
| Telemetry backend | shared platform | U1、U2、U3、U4 | U4 namespace、allowlist 属性、tenant / game を metric label にしない |

## Restore and retention interlock

PITR restore 後は U4 operator status と receipt read endpoint を deny し、worker は write 可能でも外部へ receipt を返しません。`expires_at <= now()` の receipt を sweep し、削除件数と検証 query を記録してから読取を再開します。restore rehearsal は期限直前と期限直後の fixture を含め、期限切れ receipt の公開が 0 件であることを確認します。

## Cost and capacity

既存 RDS / VPC / ALB を共用し、追加費用は ECS worker、SQS、EventBridge、KMS request、telemetry が主です。最初の staging load test で 30 秒 / message の仮定と DB 接続数を測り、必要 task 数を再計算します。task 1 個あたり pool 2 connection、最大 15 owner worker + scheduler / dispatcher 2 task なら U4 側上限は 34 connection とし、既存 RDS の空き budget を超える場合は max task を下げる前に DB capacity を再評価します。月次 cost は `Project` / `Environment` / `Unit` tag で集計し、50 / 80 / 100% の予算 alert を置きます。

## Sources

- `nfr-design/performance-design.md`
- `nfr-design/security-design.md`
- `nfr-design/scalability-design.md`
- `nfr-design/reliability-design.md`
- `nfr-design/logical-components.md`
- `infrastructure-design-questions.md` Q1、Q2

## Assumptions & Open Questions

- worker service time 30 秒と pool 2 connection は sizing 仮定です。load test で計測し、Terraform parameter を確定します。
- C5 v2 の詳細 schema と v1 coexistence 条件は共有 contract の更新が必要です。
