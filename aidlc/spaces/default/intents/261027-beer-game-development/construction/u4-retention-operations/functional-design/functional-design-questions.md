# Functional Design Questions - U4 Retention Operations

## Q1. Deletion receipt の所有者

削除 Saga の進捗と最終 receipt を、どの境界が所有しますか。

- A. U4 が一元所有し、各 owner Unit は completion event だけを返す
- B. 各 owner Unit が receipt を所有し、U4 は集約 view だけを持つ
- X. Other (please specify)

[Answer]: A. U4 が一元所有し、各 owner Unit は completion event だけを返す

## Q2. Deletion receipt の保持期間

PII や token を含まない deletion receipt を、削除完了後どれだけ保持しますか。

- A. 1 年間保持する
- B. 90 日間保持する
- C. 無期限に保持する
- X. Other (please specify)

[Answer]: A. 1 年間保持する

## Q3. Permanent failure の扱い

owner Unit が permanent-failure を返した場合、Saga をどう扱いますか。

- A. FAILED として停止し、運営者の手動再試行または解決を必要とする
- B. 他 owner の完了後に deletion を PARTIAL_COMPLETE とする
- C. 自動再試行を無期限に続ける
- X. Other (please specify)

[Answer]: A. FAILED として停止し、運営者の手動再試行または解決を必要とする
