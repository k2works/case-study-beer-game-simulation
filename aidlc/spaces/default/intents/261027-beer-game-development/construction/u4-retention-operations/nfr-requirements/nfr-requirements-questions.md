# NFR Requirements Questions - U4 Retention Operations

## Q1. 通常削除の完了目標

- A. 期限到達後 24 時間以内に 99% を完了する
- B. 期限到達後 1 時間以内に 99% を完了する
- C. 期限到達後 7 日以内に 99% を完了する
- X. Other (please specify)

[Answer]: A. 期限到達後 24 時間以内に 99% を完了する

## Q2. 自動再試行の上限

- A. 最大 5 回、指数 backoff と jitter を使用する
- B. 最大 3 回、指数 backoff と jitter を使用する
- C. 最大 10 回、指数 backoff と jitter を使用する
- X. Other (please specify)

[Answer]: A. 最大 5 回、指数 backoff と jitter を使用する

## Q3. 失敗 alert の目標

- A. permanent failure または retry 枯渇から 5 分以内に通知する
- B. 15 分以内に通知する
- C. 1 時間以内に通知する
- X. Other (please specify)

[Answer]: A. permanent failure または retry 枯渇から 5 分以内に通知する
