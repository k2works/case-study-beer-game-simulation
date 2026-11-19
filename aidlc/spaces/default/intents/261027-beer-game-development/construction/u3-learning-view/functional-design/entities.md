# Entities - U3 Learning View

```yaml
entities:
  - name: ObservationProjection
    description: プレイ中に公開可能な進行状況と逆算防止済みチーム合計
    attributes:
      - {name: projectionId, logical_type: identifier, required: true, unique: true}
      - {name: sessionId, logical_type: identifier, required: true, unique: true, references: GameSessionState}
      - {name: sourceVersion, logical_type: integer, required: true, min: 0}
      - {name: currentWeek, logical_type: integer, required: true, min: 1, max: 50}
      - {name: currentStep, logical_type: integer, required: true, min: 1, max: 12}
      - {name: completionStatus, logical_type: role-completion-map, required: true}
      - {name: safeTeamTotals, logical_type: aggregate-values, required: false}
      - {name: suppressionReasons, logical_type: reason-list, required: true, default: []}
    constraints: [role-level values and future demand are never stored in the public projection]
  - name: ReviewProjection
    description: 終了済みゲームの同一週軸による需要・役割別状態・費用時系列
    attributes:
      - {name: projectionId, logical_type: identifier, required: true, unique: true}
      - {name: sessionId, logical_type: identifier, required: true, unique: true, references: GameSessionState}
      - {name: projectionVersion, logical_type: integer, required: true, min: 1}
      - {name: sourceVersion, logical_type: integer, required: true, min: 0}
      - {name: weeklySeries, logical_type: week-indexed-series, required: true}
      - {name: status, logical_type: enum, required: true, allowed_values: [BUILDING, READY, FAILED]}
    constraints: [READY requires an ended session and complete contiguous week series]
  - name: ExportPackage
    description: CSV と JSON を同一 canonical dataset から生成した完全な export
    attributes:
      - {name: exportId, logical_type: identifier, required: true, unique: true}
      - {name: sessionId, logical_type: identifier, required: true, references: GameSessionState}
      - {name: schemaVersion, logical_type: string, required: true}
      - {name: sourceVersion, logical_type: integer, required: true}
      - {name: formats, logical_type: enum-set, required: true, allowed_values: [CSV, JSON]}
      - {name: status, logical_type: enum, required: true, allowed_values: [PENDING, GENERATING, COMPLETE, FAILED]}
      - {name: artifactRefs, logical_type: object-reference-map, required: false}
      - {name: failureCode, logical_type: string, required: false}
    constraints: [COMPLETE requires both formats from the same sourceVersion; partial artifacts are not published]
relationships:
  - {from: ObservationProjection, to: GameSessionState, cardinality: one-to-one, direction: derived-from}
  - {from: ReviewProjection, to: GameSessionState, cardinality: one-to-one, direction: derived-from}
  - {from: ExportPackage, to: ReviewProjection, cardinality: many-to-one, direction: generated-from}
```

ObservationProjection はプレイ中の安全な表示、ReviewProjection は終了後分析、ExportPackage は完全な 2 形式出力を所有します。

