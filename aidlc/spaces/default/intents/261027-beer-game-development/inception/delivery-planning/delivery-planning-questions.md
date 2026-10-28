# Delivery Planning Questions

## Strategic Questions

### Q1 Build order

Bolt（作業の一部を実行可能な状態まで仕上げる 1 回の build pass）の順序は、どの考え方を優先しますか？

- A. Walking skeleton first: 最小の end-to-end slice を先に完成させ、その後は risk と value を均衡させる
- B. Risk first: 技術・契約上の不確実性が高い部分から進める
- C. Value first: 利用者価値が高い機能から進める
- X. Other (please specify)

[Answer]: A. Walking skeleton first: 最小の end-to-end slice を先に完成させ、その後は risk と value を均衡させる

### Q2 Bolt size

1 つの Bolt に含める作業量は、どの単位を基本にしますか？

- A. 1 Unit per Bolt
- B. Related Units bundled
- C. Thin slices across Units
- X. Other (please specify)

[Answer]: A. 1 Unit per Bolt

### Q3 Execution

依存関係が許す U2 と U3 は、どのように進めますか？

- A. Serial
- B. Parallel where DAG allows
- X. Other (please specify)

[Answer]: A. Serial

### Q4 Prioritization model

WSJF（価値・緊急性・リスク低減を作業規模で割って順位付けする方法）のような formal scoring を使いますか？

- A. Lightweight qualitative scoring
- B. Numeric WSJF scoring
- C. No scoring model
- X. Other (please specify)

[Answer]: A. Lightweight qualitative scoring

### Q5 External dependencies

外部 API、教材データ、承認、別 team の hand-off など、delivery を止め得る依存関係はありますか？

[Answer]: JSD 教材と照合するキット準拠需要系列などの値の確認のみです。owner は教材確認を行う進行役 / product owner、U1 着手前に確定し、遅延時は custom series による技術検証を先行して正式な準拠判定を保留します。

### Q6 Greatest concern

この build で最も心配していることは何ですか？

[Answer]: 週次計算の正確性、週確定の冪等性、役割別情報制約、障害後の復旧です。U1 の walking skeleton で最優先に実証します。

## Per-Bolt Questions

各 Bolt について、含める Unit、walking skeleton 該当性、Definition of Done、confidence hypothesis、担当を上記回答と既存成果物から確定します。

## Sources

- `aidlc/spaces/default/intents/261027-beer-game-development/inception/requirements-analysis/requirements.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/user-stories/stories.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/refined-mockups/mockups.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/domain-design/components.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/units-generation/unit-of-work.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/units-generation/unit-of-work-dependency.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/units-generation/unit-of-work-story-map.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/contract-design/contract-summary.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/practices-discovery/team-practices.md`

## Assumptions & Open Questions

- `contract-summary.md` の Major finding は受容済みですが、該当 Unit の Functional / NFR Design と implementation plan で解消する必要があります。
