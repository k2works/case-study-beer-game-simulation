# CI/CD Pipeline - U4 Retention Operations

## Pipeline stages and gates

| Stage | Gate | Evidence |
|---|---|---|
| Format / lint / type-check | すべて pass | repository の既存 CI task |
| Unit / BDD / contract test | U4 Saga、5 retry、stale attempt、C4 / C5 v1 / v2 compatibility を検証 | Given / When / Then と provider / consumer fixture |
| Infrastructure validation | `terraform fmt`、validate、plan、policy check | IAM least privilege、KMS、private subnet、DLQ、PITR、expiry sweep gate |
| Integration / failure injection | RDS transaction、SQS 重複、out-of-order C5、restart、restore rehearsal | 期限切れ receipt 公開 0 件、FAILED の通知 5 分以内 |
| Staging rollout | 自動 deploy と smoke / load test | 23 concurrent due game、status p95 1 秒、scheduler cycle 5 分 |
| Production promotion | 明示的な手動承認 | staging の test、Terraform plan、v2 rollout checklist |

## C5 v2 migration sequence

1. U4 に v2 completion consumer を先行 deploy し、`attempt` を必須として `current_attempt` と照合します。v1 channel は隔離 queue へ routing し、Saga の状態遷移に使いません。
2. U1 / U2 / U3 producer を owner ごとに v2 channel へ切り替え、C4 に含まれる attempt を C5 に echo します。切替対象の契約 test が pass するまで U4 の削除開始を対象 owner / game で止めます。
3. 1 release window は v1 / v2 channel を併存させ、v1 event は監査 / DLQ で確認します。v1 traffic が 0、全 producer の v2 contract test が pass、未完 v1 Saga が 0 を確認してから v1 を撤去します。

共有 `contract-summary.md` の C5 schema と channel の更新は code generation 前の必須作業です。v1 を current attempt に推測で結び付けません。

## Deployment and rollback

application は ECS rolling deployment とし、staging は `main` merge 時に自動 deploy、production は手動承認後に deploy します。database migration は expand → dual-compatible interval → contract の順に適用し、旧 task が生存中に required column / channel を削除しません。失敗時は producer を v2 の既知良好 image に戻し、U4 の新規削除開始を止め、queue と durable Saga を保持して再開します。v1 producer への rollback は v2 に migration 済みの Saga がある間は許可しません。

## Secrets and artifact handling

CI は短期 OIDC role を使用し、Terraform state は暗号化と排他 lock を使用します。DB credential、HMAC key、KMS grant は Secrets Manager / IAM を通じて参照します。image は commit SHA digest で固定し、scanner と SBOM を通してから registry へ公開します。

## Sources

- `nfr-design/security-design.md`
- `nfr-design/reliability-design.md`
- `nfr-design/reviews/review-01.md`
- `infrastructure-design-questions.md` Q3
- `inception/contract-design/contract-summary.md`

## Assumptions & Open Questions

- C5 の version 2 schema と v1 併存期間の具体的な release calendar は共有 contract 更新時に確定します。
- NFR2.2 の「最大 5 回の再試行」と NFR Design の「初回を含む total attempt 5 回」は不一致です。Code Generation 前に上流要件どおり初回 + 最大 5 retry へ修正します。
