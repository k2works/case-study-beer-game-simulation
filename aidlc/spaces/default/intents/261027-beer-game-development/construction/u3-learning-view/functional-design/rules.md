# Business Rules - U3 Learning View

```yaml
rules:
  - id: BR11.1
    statement: 観察 projection は現在週、step、役割別完了状況と安全なチーム合計だけを公開する
    category: authorization
    applies_to: ObservationProjection
    trigger: observation query
    logic: IF session is running THEN exclude role values and future demand
    violation: return forbidden or omit protected values
    source: FR3.3, FR3.4
  - id: BR11.2
    statement: 集計母数が 2 未満または他の公開値から個別値を逆算できる場合は合計を抑止する
    category: policy
    applies_to: ObservationProjection
    trigger: projection build
    logic: IF disclosure risk exists THEN store suppression reason instead of totals
    violation: no unsafe aggregate is published
    source: FR3.3
  - id: BR12.1
    statement: 役割別の終了後時系列は session が ENDED の場合だけ公開する
    category: authorization
    applies_to: ReviewProjection
    trigger: review query
    logic: IF session status is not ENDED THEN deny disclosure
    violation: return GAME_NOT_ENDED without series
    source: FR7.1
  - id: BR12.2
    statement: review series は同一週軸で完全かつ連続していなければ READY にしない
    category: constraint
    applies_to: ReviewProjection
    trigger: event consume or rebuild
    logic: IF version gap or missing week exists THEN mark BUILDING or FAILED and rebuild
    violation: distinguish no-data from load failure
    source: FR7.1, FR7.4
  - id: BR13.1
    statement: CSV と JSON は同一 canonical dataset と sourceVersion から生成する
    category: constraint
    applies_to: ExportPackage
    trigger: export request
    logic: IF both formats validate and quantities/costs match THEN mark COMPLETE
    violation: mark FAILED and publish neither partial artifact
    source: FR7.2, FR7.3, FR7.4
  - id: BR13.2
    statement: export 作成は進行役だけに許可し query ごとに membership と session status を再検査する
    category: authorization
    applies_to: ExportPackage
    trigger: export request or download
    logic: IF actor is facilitator and session ENDED THEN authorize
    violation: return forbidden without object reference
    source: FR3.4, FR7.2
  - id: BR14.1
    statement: domain event は eventId で冪等化し sessionId と aggregateVersion の順序を検査する
    category: constraint
    applies_to: all projections
    trigger: C3 event consume
    logic: IF duplicate THEN acknowledge without change; IF gap THEN stop and rebuild
    violation: projection does not advance beyond the gap
    source: NFR2
```

| Rule | Summary |
|---|---|
| BR11.1〜BR11.2 | プレイ中の情報制約と逆算防止 |
| BR12.1〜BR12.2 | 終了後分析と完全性 |
| BR13.1〜BR13.2 | export 一致性・完全性・認可 |
| BR14.1 | event 冪等性と順序 |

