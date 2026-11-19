# Scalability Design - U2 Session Continuity

## Scaling model

application は stateless とし、少なくとも 2 instances を load balancer 配下に置きます。sticky session は使わず、session state、credential、idempotency、outbox の authority は PostgreSQL とします。SSE reconnect は任意の instance に接続でき、`Last-Event-ID` と snapshot reconciliation で追いつきます。

## Capacity model

- baseline: 25 concurrent games、100 SSE connections、75 simultaneous reconnects。
- application scale-out threshold: 5 minutes の CPU 60% または event-loop lag p95 100 ms 超過。
- scale-in threshold: CPU 30% 未満かつ active connections が instance capacity の 40% 未満で 15 minutes 継続。
- 1 instance の soft limit は 500 SSE connections、20 database connections とし、超過前に load balancer が新規接続を別 instance へ振り分けます。
- PostgreSQL connection 総数は instance count × pool size が database limit の 70% を超えないよう autoscaling upper bound を設定します。

## Event distribution

transactional outbox を複数 dispatcher が `FOR UPDATE SKIP LOCKED` で claim し、eventId により consumer / SSE projection を冪等化します。session ごとの `aggregateVersion` と `eventSequence` を検査し、gap があれば snapshot へ切り替えます。ordering は session 単位で保証し、異なる session 間の global ordering は要求しません。

## Data growth

主要 index は credential digest、session + version、outbox status + nextAttemptAt、idempotency scope + key とします。監査と outbox は Infrastructure Design で定める retention / archive policy に従い partitioning 可能な schema とします。sharding は baseline の 10 倍の sustained load または single database の write saturation が確認されるまで導入しません。

## Verification

2 application instances と PostgreSQL を使う integration test で instance 切替、duplicate delivery、event gap、out-of-order claim、sticky-session 非依存を検証します。

## Requirement coverage

NFR12.1、NFR12.2、NFR12.3、NFR10.2、NFR10.3 をこの設計で満たします。

