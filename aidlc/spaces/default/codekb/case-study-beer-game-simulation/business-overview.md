# Business Overview

## Business Domain

本リポジトリは、改訂版ビールゲームを複数人で実施するデジタル学習シミュレーションを開発するためのケーススタディです。対象業務は、工場、一次卸、二次卸、小売店からなる 4 段階サプライチェーンの週次運営と、Bullwhip Effect の振り返りです。

## Purpose and Value

参加者は役割ごとに制限された情報だけを使って発注または生産要請を判断します。システムは注文・配送・生産の遅延、在庫、受注残、費用を正確に計算し、進行役の運営負荷と手作業ミスを減らします。終了後には全役割の時系列を開示し、局所最適な意思決定が全体の振動を増幅する過程を学べるようにします。

## Key Capabilities

- ゲーム設定、参加コード、参加者と 4 役割の割当て
- 改訂版キットの 12 ステップに沿った同期型週次進行
- 非負整数の発注・生産要請と、注文・配送・生産の 2 週遅延
- 在庫、受注残、出荷、週次費用、累積費用の決定論的計算
- 一時停止、再開、代理入力、確定済み週からの復元、監査履歴
- 終了後の需要・注文・在庫・受注残・出荷・費用の比較表示と出力

## Current Delivery State

要件の正本は `docs/requirements/beer-game/requirements_definition.md` です。`apps/beer-game/` は空であり、ビールゲーム本体の実装、API、データベース、UI、テストはまだ存在しません。既存コードはドキュメント生成と開発運用の補助タスクです。

## Sources

- `docs/requirements/beer-game/requirements_definition.md`
- `README.md`
- `apps/beer-game/`

## Assumptions & Open Questions

- ASM-01 の既定需要系列は未確定です。
- アプリケーション技術スタック、リアルタイム通信方式、永続化方式は後続設計で決定します。
