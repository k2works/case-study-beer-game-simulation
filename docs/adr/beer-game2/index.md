# beer-game2 — ADR

beer-game2 プロジェクトの ADR ドキュメントです。

## ドキュメント一覧

| ADR | 決定内容 | ステータス |
| :--- | :--- | :--- |
| [ADR-001](./001-rebuild-as-beer-game2.md) | beer-game2 として要件と設計を改訂し、作り直す | 承認済み |
| [ADR-002](./002-adopt-v1-adrs.md) | v1 の ADR の引き継ぎ方を定める | 提案中 |
| [ADR-003](./003-ports-and-adapters-with-lint.md) | ドメインモデル + ポートとアダプターを採用し、層の依存を lint で守る | 提案中 |
| [ADR-004](./004-separate-game-and-session-aggregates.md) | Game（準備）と Session（進行）の集約を分ける | 提案中 |
| [ADR-005](./005-role-results-and-sql-read-models.md) | 週結果を役割別の行で保存し、観察・振り返り・出力は SQL で返す | 提案中 |
| [ADR-006](./006-sse-version-only.md) | SSE は版の通知だけとし、取りこぼしの再生をしない | 提案中 |
| [ADR-007](./007-cascade-deletion-without-queues.md) | 保持削除を 1 トランザクションのカスケード削除にし、キューを廃止する | 提案中 |
| [ADR-008](./008-auto-commit-and-event-audit.md) | 自動確定を最後の意思決定と同じトランザクションで行い、監査をイベントに統一する | 提案中 |
| [ADR-009](./009-credential-key-versions.md) | 資格の鍵に版を持たせ、すべての資格に有効期限と失効を持たせる | 提案中 |
| [ADR-010](./010-url-router-and-features.md) | URL ルーターを導入し、機能単位の構成にする | 提案中 |
| [ADR-011](./011-cloudfront-domain-tls-headers.md) | 独自ドメイン、TLS 1.2 以上、セキュリティヘッダーを含む CloudFront の単一オリジンにする | 提案中 |
| [ADR-012](./012-delivery-pipeline-and-terraform.md) | ECR、OIDC、ステージング自動・本番承認・ブルー/グリーンのパイプラインと、リモートの Terraform を採用する | 提案中 |
| [ADR-013](./013-tech-stack-versions.md) | 技術スタックの版を、確認済みの値で固定する（Node 26 LTS、PostgreSQL 18、TypeScript 6.0） | 提案中 |

## 補足

- 実ドキュメントを追加したら、この一覧を更新します。
- beer-game（v1）の ADR は [こちら](../beer-game/index.md) です。v2 で引き継ぐ判断は、v2 の ADR として改めて記録します。
