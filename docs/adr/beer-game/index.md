# beer-game — ADR

beer-game プロジェクトの ADR ドキュメントです。

## ドキュメント一覧

| ADR | 決定内容 | ステータス |
| :--- | :--- | :--- |
| [ADR-001](./001-pure-weekly-simulation.md) | 週次計算を純粋関数として分離する | 提案中 |
| [ADR-002](./002-stateless-api-row-lock.md) | 状態を持たない API とゲーム単位の行ロックで整合性を保つ | 提案中 |
| [ADR-003](./003-outbox-projection-over-event-sourcing.md) | イベントソーシングを採用せず、アウトボックスと投影の簡易形にする | 提案中 |
| [ADR-004](./004-sse-version-notification.md) | リアルタイム通知は SSE で版を通知し、状態は再取得する | 提案中 |
| [ADR-005](./005-credential-digest-only.md) | 資格はダイジェストだけを保存し、冪等応答は暗号化して保存する | 提案中（コンプライアンス未達あり） |
| [ADR-006](./006-spa-without-router-or-store.md) | フロントエンドは SPA とし、ルーターと状態管理ライブラリを導入しない | 提案中 |
| [ADR-007](./007-cloudfront-single-origin.md) | Web と API を CloudFront の単一オリジンで配信する | 提案中 |
| [ADR-008](./008-retention-saga.md) | 保持期間後の削除を SQS と所有者別ワーカーの Saga で実行する | 提案中（コンプライアンス未達あり） |

## 補足

- 実ドキュメントを追加したら、この一覧を更新します。
- 001〜008 は実装済みの決定を事後に記録したもので、人のレビュー（承認）はまだです。承認後に `apply-okf` の `verify` で `stable` にします。
