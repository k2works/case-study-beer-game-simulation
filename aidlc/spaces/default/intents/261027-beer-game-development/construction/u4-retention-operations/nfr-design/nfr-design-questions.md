# NFR Design Questions - U4 Retention Operations

## Q1. 遅延した完了通知の attempt 整合性

C5 `DeletionCompleted` は現在 `attempt` を持たないため、過去 attempt の遅延通知を現在の処理と区別できません。どの方式にしますか。

- A. C5 に必須の `attempt` を追加し、U4 は現在 attempt と一致する通知だけを状態更新に使用する（推奨）
- B. attempt ごとに `deletionId` を新規発行し、親 deletion ID を別に持つ
- C. owner ごとの command token を追加して照合する
- X. Other (please specify)

[Answer]: A

## Q2. 24 時間削除 SLO の評価方法

「期限到達した deletion saga の 99% を 24 時間以内」の評価窓と母集団をどう定義しますか。

- A. rolling 30 日、期限到達した全 Saga を母集団とし、運営者が承認した除外だけを別集計する（推奨）
- B. calendar month、期限到達した全 Saga を母集団とし、除外を認めない
- C. rolling 7 日、COMPLETED になった Saga だけを母集団にする
- X. Other (please specify)

[Answer]: A

## Q3. 5 分以内通知の完了条件

permanent failure または retry 枯渇後の「5 分以内に運営者へ通知」は何をもって達成としますか。

- A. alert manager が運営 channel への送信を受理し、delivery 成否を記録した時点（推奨）
- B. alert manager が通知を生成した時点
- C. 運営者が通知を確認した時点
- X. Other (please specify)

[Answer]: A

## Sources

- `nfr-requirements/reliability-requirements.md`
- `nfr-requirements/observability-requirements.md`
- `inception/contract-design/contract-summary.md` C4 / C5

## Assumptions & Open Questions

- C5 に必須の `attempt` を追加し、現在 attempt と一致する通知だけを状態更新に使用します。
- 削除 SLO は rolling 30 日で、期限到達した全 Saga を母集団とし、承認済み除外は別集計します。
- 通知 SLI は運営 channel が送信を受理し、delivery 成否を記録した時点で達成とします。
