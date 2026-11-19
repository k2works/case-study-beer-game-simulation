# Requirements Analysis - ビールゲームシミュレーション

## Intent Analysis

本プロジェクトは、JSD 改訂版ビールゲームの 4 役割、情報制約、物流・注文・生産の遅延、在庫・受注残・費用計算をデジタル上で再現するものです。目的は勝敗ではなく、分散した合理的意思決定が Bullwhip Effect を生む構造を体験し、終了後の振り返りで理解できることです。

初回の walking skeleton は「1 ゲーム、4 役割、1 週分の意思決定と確定、状態表示」を端から端まで動作させます。[desc] [memory:M1]

## Functional Requirements

### FR1 ゲームの準備

- **FR1.1** 進行役は、名称、終了週（最大 50）、初期在庫、遅延量、費用単価、公開範囲を指定してゲームを作成できること。
- **FR1.2** システムは JSD 教材と照合済みのキット準拠需要系列を必須プリセットとして提供すること。[Q1]
- **FR1.3** 進行役は、各週が非負整数である任意の需要系列を登録できること。空、負数、小数、終了週に対する不足を拒否し、入力内容を保持して修正方法を表示すること。
- **FR1.4** キット準拠の初期値や需要系列を変更したゲームは「カスタム」と明示すること。

**Acceptance criteria**

- Given 有効な設定、When 進行役が作成する、Then 参加コード付きの準備中ゲームが一度だけ作成される。
- Given 無効な需要系列、When 保存する、Then ゲームは作成されず対象週と修正内容が示される。

### FR2 参加と役割割当て

- **FR2.1** 参加者は有効な参加コードと表示名でロビーに参加できること。
- **FR2.2** システムは参加者の browser に推測困難な復帰 token を保存し、切断後に同じ参加者・役割として復帰させること。アカウント登録は求めない。[Q2]
- **FR2.3** 進行役は工場、一次卸、二次卸、小売店を重複なく割り当て、4 役割が揃うまで開始できないこと。
- **FR2.4** 同一役割の複数参加者は、1 つの共同意思決定値を編集できること。最後の確定前更新を正とし、同時更新の競合を通知すること。

### FR3 役割別情報制御

- **FR3.1** プレイ中の参加者には、自役割の在庫、受注残、到着入荷、当週受注、許可された履歴だけを表示すること。
- **FR3.2** 他役割の在庫、受注残、意思決定値、将来需要は UI、API、export のすべてで取得できないこと。
- **FR3.3** 観察者には現在週、現在ステップ、各役割の入力完了状況、在庫・受注残・注文のチーム合計値を表示すること。役割別値と未来需要は開示しない。[Q4]
- **FR3.4** すべての読取り・書込みでゲームと役割の権限を server 側で検査すること。

### FR4 週次進行と意思決定

- **FR4.1** システムは改訂版キットの 12 ステップに沿って全役割を同期させ、未完了の必須ステップを飛ばせないこと。
- **FR4.2** 小売店、二次卸、一次卸は非負整数の発注数、工場は非負整数の生産要請数を入力できること。
- **FR4.3** 未入力、空白、小数、負数、許容上限を超える値は確定できず、入力を保持して修正内容を表示すること。
- **FR4.4** 全 4 役割の意思決定が揃ったときだけ週を確定し、再送・連打・同時操作でも二重計上しないこと。
- **FR4.5** 古い画面からの応答や確定済み週の入力は適用せず、最新状態を返すこと。

### FR5 在庫・受注残・遅延・費用

- **FR5.1** 配送と注文情報はそれぞれ 2 週、工場生産は 2 段階の遅延を経ること。
- **FR5.2** 当週利用可能量を「前週末在庫 + 当週入荷」、充足対象を「前週末受注残 + 当週受注」とすること。
- **FR5.3** 当週出荷数を利用可能量と充足対象の小さい方とし、在庫と受注残を常に 0 以上に保つこと。
- **FR5.4** 週次費用を「週末在庫 × 0.50 + 週末受注残 × 1.00」とし、小数誤差を生まない固定小数または整数単位で計算すること。
- **FR5.5** 同じ初期状態と意思決定系列は、常に同じ週次状態と費用を生むこと。

### FR6 進行制御と復旧

- **FR6.1** 進行役はゲームを一時停止、再開、終了でき、停止中と終了後の新規確定を拒否すること。
- **FR6.2** 進行役は不在参加者の代理入力を行え、操作者、対象役割、時刻、値を履歴に残すこと。
- **FR6.3** 障害や再起動後は最後の確定済み週から復旧し、在庫、受注残、遅延、履歴、費用を一致させること。
- **FR6.4** 週確定の複数書込みは All-or-Nothing とし、中断時に部分更新を残さないこと。

### FR7 分析と export

- **FR7.1** 終了後は需要、役割別注文、在庫、受注残、出荷、週次費用、累積費用を同じ週軸で比較できること。
- **FR7.2** ゲーム設定、全週・全役割の状態、意思決定、費用、操作履歴を CSV と JSON の両方で出力できること。[Q5]
- **FR7.3** CSV の列順と JSON schema は version を持ち、同じゲームの数量と費用が両形式で一致すること。
- **FR7.4** データがない場合は「データなし」と失敗を区別し、部分的な export を完全な結果と表示しないこと。

### FR8 保持と削除

- **FR8.1** ゲーム記録の保持期間は既定 90 日とし、運営者が変更できること。[Q3]
- **FR8.2** 保持期限後はゲーム記録、操作履歴、復帰 token を削除し、実行結果を監査可能な形で記録すること。
- **FR8.3** 削除中の障害は半分の状態を完了として扱わず、再試行可能とすること。

## Non-Functional Requirements

- **NFR1 Performance**: 15 チーム、各チーム 4 役割 + 進行役の同時利用下で、入力確定の p95 を 1 秒以内、週確定後の画面反映を 2 秒以内とする。
- **NFR2 Reliability**: 週確定と削除は原子的で、重複実行が同一結果になること。受理済み書込みを一時障害で失わないこと。
- **NFR3 Security**: 参加コードと復帰 token は十分な entropy を持ち、通信時に保護すること。全オブジェクト操作でゲーム・役割権限を検査し、secret や token を log、URL、export に出力しないこと。
- **NFR4 Privacy**: 必須の個人情報は表示名のみとし、保持期間と削除完了を運営者が確認できること。
- **NFR5 Accessibility**: すべての主要機能が keyboard で操作でき、色だけで状態を示さず、WCAG 2.2 AA の contrast 基準を満たすこと。
- **NFR6 Compatibility**: 最新 2 世代の Chrome、Edge、Firefox、Safari の desktop 版で専用ソフトなしに利用できること。
- **NFR7 Observability**: ゲーム作成、役割変更、代理入力、週確定、停止、再開、終了、削除に correlation ID 付きの監査履歴を残し、個人情報や token を含めないこと。
- **NFR8 Maintainability**: BDD で Given/When/Then の振る舞い例を実装前に定義し、Unit Test と主要境界の Integration Test を CI で実行し、line coverage 80% 以上を保つこと。
- **NFR9 Delivery**: `develop` を統合 branch、`main` を release branch とし、`main` merge 後に staging へ自動反映すること。production は手動承認後に deploy すること。

## Constraints

- JSD 改訂版キットの 4 役割、12 ステップ、2 週遅延、費用構造、情報制約を保持します。
- application は `apps/beer-game/` に新規実装し、既存の文書・運用自動化を再利用します。
- formatter、linter、type-check、test、coverage が CI で成功しない変更は merge しません。
- 玩金決済、教材販売、汎用 SCM、実在企業の需給計画は対象外です。

## Assumptions & Open Questions

- [assumption] JSD 教材と照合した需要系列の具体値は、実装前の教材確認で確定できるものとします。値の確定は FR1.2 の受入前提です。
- [assumption] 観察者に公開する合計値は、個別役割の値を逆算できないチーム全体値とします。
- [assumption] 需要数、発注数、生産要請数の上限は、データ型と運用上の現実性に基づき Domain Design で確定します。

## Out of Scope

- 自動補充 strategy、同一役割の投票・多数決、プレイ中の役割別全体情報の観察者開示。
- 決済、教材販売、汎用的なサプライチェーン計画、実在企業データ連携。
- mobile 専用 application と offline プレイ。一時的な切断からの再接続は対象です。

## Sources

- Initial description: `docs/requirements/beer-game/requirements_definition.md の要件を元に開発を開始` [desc]
- `docs/requirements/beer-game/requirements_definition.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/business-overview.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/architecture.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/code-structure.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/practices-discovery/team-practices.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/requirements-analysis/requirements-analysis-questions.md` [Q1] [Q2] [Q3] [Q4] [Q5]

## Traceability Summary

| Source | Requirement coverage |
|---|---|
| 原要件の FR-01〜FR-15 / BR-01〜BR-14 | FR1〜FR8, NFR1〜NFR7 |
| Q1〜Q5 | FR1.2, FR2.2, FR8.1, FR3.3, FR7.2 |
| Team practices | NFR8, NFR9, walking skeleton |
| Reverse Engineering | 新規 application と既存運用基盤の境界 |
