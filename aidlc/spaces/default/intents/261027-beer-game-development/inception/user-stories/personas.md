# Personas

## P1 進行役

- **Role**: 学習セッションの準備、役割割当て、進行、復旧、振り返りを管理する。
- **Goals**: 同一条件でゲームを再現する。操作ミスより学習支援に集中する。
- **Pain points**: 手計算、進行同期、不在者の代理、複数チーム比較。
- **Context**: desktop browser、研修時に継続利用。
- **Priority**: Primary.

## P2 生産役

- **Role**: 工場として受注・在庫・生産遅延を見て生産要請を決定する。
- **Goals**: 限られた情報で意思決定し、需要変動が上流へ伝播する構造を体験する。
- **Pain points**: 配送と生産の複合遅延、将来需要の非公開。
- **Context**: desktop browser、高頻度の週次利用。
- **Priority**: Primary.

## P3 流通役

- **Role**: 一次卸、二次卸、小売店のいずれかとして発注を決定する。
- **Goals**: 自役割の在庫と受注残を把握し、上流へ発注する。
- **Pain points**: 情報遅延と物流遅延、他役割の情報が見えない状況での意思決定。
- **Context**: desktop browser、小売店のみ当週需要を確認。
- **Priority**: Primary.

## P4 観察者

- **Role**: 意思決定に干渉せず、進行状況と振り返りを観察する。
- **Goals**: プレイ中は許可された集計値を見て、終了後は役割別時系列を比較する。
- **Pain points**: 役割別情報を公開しすぎると学習条件を壊す。
- **Context**: desktop browser、読取り専用。
- **Priority**: Secondary.

## Relationships

進行役がゲームと役割を準備し、生産役と流通役が分散して意思決定します。観察者は読取り専用であり、個別役割の非公開値にはアクセスしません。

## Sources

- `aidlc/spaces/default/intents/261027-beer-game-development/inception/requirements-analysis/requirements.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/business-overview.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/user-stories/user-stories-questions.md`

## Assumptions & Open Questions

None.
