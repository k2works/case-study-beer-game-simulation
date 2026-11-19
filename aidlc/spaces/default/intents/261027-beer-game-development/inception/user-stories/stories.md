# User Stories

## Epic 1 - ゲーム準備と参加

### US1.1 ゲームを作成する

**As a** 進行役、**I want** JSD 準拠またはカスタム条件でゲームを作成したい、**so that** 同一条件の学習セッションを再現できる。

- **Priority**: Must Have
- **Dependencies**: None
- **AC1.1.1** Given 有効なキット準拠設定、When 作成する、Then 参加コード付きの準備中ゲームが一度だけ作成される。
- **AC1.1.2** Given 無効な需要系列、When 保存する、Then 作成せず対象週と修正内容を表示する。
- **AC1.1.3** Given 準拠値を変更した設定、When 作成する、Then 「カスタム」と明示する。
- **INVEST**: 単独でデモ可能、条件入力は交渉可能、検証可能。

### US1.2 参加して役割を受け取る

**As a** 生産役または流通役、**I want** 参加コードでロビーに入り役割を受け取りたい、**so that** アカウント登録なしで学習を始められる。

- **Priority**: Must Have
- **Dependencies**: US1.1
- **AC1.2.1** Given 有効な参加コード、When 表示名を入力する、Then ロビーに参加し復帰 token が保存される。
- **AC1.2.2** Given 無効または終了済みコード、When 参加する、Then 参加せず理由を表示する。
- **AC1.2.3** Given 4 役割が揃っていない、When 進行役が開始する、Then 開始を拒否し不足役割を示す。
- **INVEST**: 参加と割当ての価値を一貫して提供。

## Epic 2 - Walking Skeleton: 1 週の意思決定

### US2.1 役割別の週次状況を確認する

**As a** 生産役または流通役、**I want** 自役割に許された週次状況だけを見たい、**so that** 情報制約を保って意思決定できる。

- **Priority**: Must Have
- **Dependencies**: US1.2
- **AC2.1.1** Given プレイ中、When 自役割画面を開く、Then 自役割の在庫・受注残・入荷・受注だけを表示する。
- **AC2.1.2** Given 他役割の resource ID、When UI または API で取得する、Then 権限エラーとして値を返さない。
- **AC2.1.3** Given 小売店以外の役割、When 将来需要または当週需要を取得する、Then 開示しない。
- **INVEST**: 読取り範囲に限定した独立 story。

### US2.2 発注または生産要請を決定する

**As a** 生産役または流通役、**I want** 当週の数量を入力・確定したい、**so that** 分散した意思決定で supply chain を運営できる。

- **Priority**: Must Have
- **Dependencies**: US2.1
- **AC2.2.1** Given 未確定の当週、When 非負整数を入力する、Then 流通役は発注、生産役は生産要請として保存できる。
- **AC2.2.2** Given 負数・小数・空白、When 確定する、Then 入力を保持して修正方法を示す。
- **AC2.2.3** Given 同一役割の複数参加者、When 同時更新する、Then 更新競合を示し、変更を黙って失わない。
- **INVEST**: 意思決定操作に限定。

### US2.3 1 週を原子的に確定する

**As a** 進行役、**I want** 4 役割の入力後に 1 週を一度だけ確定したい、**so that** 手作業ミスなしで正しい状態を残せる。

- **Priority**: Must Have
- **Dependencies**: US2.2
- **AC2.3.1** Given 4 役割の入力完了、When 週確定する、Then 12 ステップ順の遅延・入荷・出荷・在庫・受注残・費用が一取引で保存される。
- **AC2.3.2** Given 同じ確定要求が重複または同時到着、When 処理する、Then 結果と費用は一度だけ計上される。
- **AC2.3.3** Given 確定中の障害、When 処理が中断する、Then 部分更新を残さず再試行できる。
- **AC2.3.4** Given 同一初期状態と意思決定、When 再計算する、Then 全状態と費用が一致する。
- **INVEST**: walking skeleton の核心価値。

## Epic 3 - 継続と復旧

### US3.1 停止・代理入力・再開を管理する

**As a** 進行役、**I want** セッションを停止し、必要な代理入力後に再開したい、**so that** 不在者や一時的な中断があっても学習を継続できる。

- **Priority**: Must Have
- **Dependencies**: US2.3
- **AC3.1.1** Given 一時停止中、When 参加者が新規確定する、Then 拒否し既存入力を失わない。
- **AC3.1.2** Given 進行役が代理入力、When 確定する、Then 操作者・役割・時刻・値を監査履歴に残す。
- **AC3.1.3** Given 再開操作、When 状態を復帰する、Then 最後の確定済み週から入力可能になる。
- **INVEST**: 運営継続性に限定。

### US3.2 切断後に同じ役割へ復帰する

**As a** 生産役または流通役、**I want** 一時切断後に元の役割へ戻りたい、**so that** 確定済みデータと作業を失わず継続できる。

- **Priority**: Must Have
- **Dependencies**: US1.2
- **AC3.2.1** Given 有効な復帰 token、When 再接続する、Then 同じゲームと役割の最新状態を表示する。
- **AC3.2.2** Given 無効または削除済み token、When 再接続する、Then 復帰せず進行役への確認方法を示す。
- **AC3.2.3** Given 複数 tab、When 一方で週が確定される、Then 他方は古い応答を適用せず最新状態を反映する。
- **INVEST**: 復帰経路のみの縦断 story。

## Epic 4 - 観察と振り返り

### US4.1 公開範囲内でプレイを観察する

**As a** 観察者、**I want** 進行状況とチーム合計を見たい、**so that** 役割別の非公開情報を壊さず学習を観察できる。

- **Priority**: Should Have
- **Dependencies**: US2.3
- **AC4.1.1** Given プレイ中、When 観察画面を開く、Then 現在週・ステップ・完了状況・在庫・受注残・注文のチーム合計を表示する。
- **AC4.1.2** Given 観察者、When 役割別値または未来需要を取得する、Then 権限エラーとして値を返さない。
- **AC4.1.3** Given 集計対象が 1 役割だけの状態、When 逆算で個別値が漏洩する、Then 合計値を非表示とする。
- **INVEST**: 読取り専用で独立。

### US4.2 終了後に Bullwhip Effect を振り返る

**As a** 進行役または観察者、**I want** 需要と全役割の時系列を比較したい、**so that** 遅延と意思決定が変動を増幅する過程を説明できる。

- **Priority**: Must Have
- **Dependencies**: US2.3
- **AC4.2.1** Given ゲーム終了、When 分析画面を開く、Then 需要・注文・在庫・受注残・出荷・費用を同じ週軸で比較できる。
- **AC4.2.2** Given プレイ中、When 終了後専用の役割別値を取得する、Then 開示しない。
- **AC4.2.3** Given データが 0 件、When 分析画面を開く、Then 「データなし」と読込失敗を区別する。
- **INVEST**: 学習成果を完結させる story。

### US4.3 結果を CSV / JSON で出力する

**As a** 進行役、**I want** 全記録を CSV と JSON で出力したい、**so that** 表計算での比較とシステム間の再利用ができる。

- **Priority**: Should Have
- **Dependencies**: US4.2
- **AC4.3.1** Given 終了済みゲーム、When CSV と JSON を出力する、Then 設定・全週・全役割・意思決定・費用・履歴を識別できる。
- **AC4.3.2** Given 同じゲーム、When 両形式を比較する、Then 数量と費用が一致し schema version が記録される。
- **AC4.3.3** Given 出力の一部が失敗、When 処理を完了できない、Then 部分結果を完全な export として示さない。
- **INVEST**: 分析 UI と独立してテスト可能。

## Epic 5 - 保持と品質

### US5.1 保持期限後にデータを削除する

**As a** 進行役、**I want** ゲーム記録の保持期間を設定したい、**so that** 不要な参加者データを残さない。

- **Priority**: Must Have
- **Dependencies**: US1.1
- **AC5.1.1** Given 未設定、When ゲームを作成する、Then 保持期間を 90 日とする。
- **AC5.1.2** Given 保持期限到達、When 削除処理する、Then ゲーム記録・履歴・復帰 token を削除し実行結果を記録する。
- **AC5.1.3** Given 削除中の障害、When 再試行する、Then 半分の状態を完了と扱わず最終的に一度削除される。
- **INVEST**: retention lifecycle として独立。

## Cross-Cutting Acceptance

- 主要機能は keyboard で操作でき、色だけで状態を表さない。
- 15 チーム同時利用下で入力確定 p95 1 秒以内、週確定後 2 秒以内に画面反映する。
- 監査 log に token や不要な個人情報を含めない。
- Given/When/Then の振る舞い例を実装前に定義し、line coverage 80% 以上を維持する。

## Sources

- `aidlc/spaces/default/intents/261027-beer-game-development/inception/requirements-analysis/requirements.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/business-overview.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/component-inventory.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/practices-discovery/team-practices.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/user-stories/user-stories-questions.md`

## Assumptions & Open Questions

- Requirements Analysis で受容された 4 件の Major finding（需要系列値、数量上限、token security 基準、原要件の詳細 traceability）は、後続設計で明確化が必要です。
