# Contract Design Questions

## Q1. [External API] Browser と application の境界

browser UI が利用する public API の基本形式をどうしますか？

- A. versioned JSON REST/HTTP とし、状態更新は optimistic concurrency と idempotency key を使う
- B. GraphQL API とし、query / mutation / subscription を提供する
- C. server-rendered form と HTML response を中心にする
- X. Other (please specify)

[Answer]: A. versioned JSON REST/HTTP とし、状態更新は optimistic concurrency と idempotency key を使う

## Q2. [Inter-unit events] projection と deletion の連携

modular monolith 内の Unit 間 event contract をどう定義しますか？

- A. transactional outbox へ versioned event を書き、consumer は eventId で冪等化する
- B. process 内 event bus へ commit 後に直接 publish する
- C. Unit 間で database table を共有して polling する
- X. Other (please specify)

[Answer]: A. transactional outbox へ versioned event を書き、consumer は eventId で冪等化する

## Q3. [Versioning] breaking change policy

API と event schema の互換性をどう管理しますか？

- A. additive change を原則とし、breaking change は major version と移行期間を必須にする
- B. latest version のみを提供し、consumer を同時更新する
- C. contract ごとに個別 policy を決める
- X. Other (please specify)

[Answer]: A. additive change を原則とし、breaking change は major version と移行期間を必須にする

## Established constraints

- すべての command / query は server 側で game と role authorization を検査する。
- token、secret、不要な個人情報を URL、log、event、export に含めない。
- week commit と outbox event は同じ transaction に含める。
- timeout や再送でも command を二重適用しない。

## Assumptions & Open Questions

- concrete framework と transport library は後続の技術選定で決定する。
