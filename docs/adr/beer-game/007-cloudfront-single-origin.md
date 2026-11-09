---
type: ADR
title: "ADR-007: Web と API を CloudFront の単一オリジンで配信する"
description: "ブラウザから見て Web と API を同じオリジンにし、CloudFront が静的ファイルは S3、/api/ は ALB へ振り分ける。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-09T07:45:24Z }
---

# ADR-007: Web と API を CloudFront の単一オリジンで配信する

ブラウザから見て Web と API を同じオリジンにし、CloudFront が静的ファイルは S3、`/api/*` は ALB へ振り分ける。

日付: 2026-11-09

## ステータス

提案中（Terraform に定義済み。実際の環境への適用と、UI の配置手順は未確認）

## コンテキスト

認証は Cookie（`SameSite=Strict`）で行い、変更系リクエストは Origin が `ALLOWED_ORIGIN` と一致する場合だけ受け付ける。Web と API が別オリジンだと、Cookie と Origin 検査、CORS の設定が複雑になり、攻撃面も増える。

- 参考: [インフラストラクチャアーキテクチャ](../../design/beer-game/architecture-infrastructure.md)

## 決定

- CloudFront を唯一の入口とし、既定のビヘイビアは非公開の S3（OAC 経由）、`/api/*` はキャッシュなしで ALB（HTTPS のみ）へ転送する。
- `/api/*` では、Cookie、クエリ文字列、`Origin`、`Referer`、`Idempotency-Key`、`If-Match`、`Last-Event-ID` を転送する。
- API の `ALLOWED_ORIGIN` に CloudFront のドメインを設定し、CORS は許可しない（`origin: false`）。
- 開発時は Vite の dev server が `/api` を API にプロキシし、同じ同一オリジンの関係を再現する。

### 変更箇所

- `apps/beer-game/infra/main.tf`（`aws_cloudfront_distribution`、`aws_cloudfront_origin_request_policy`、`aws_lb` ほか）
- `apps/beer-game/vite.config.ts`（開発時のプロキシ）

### 代替案

- Web と API を別ドメインにして CORS を許可する: Cookie の `SameSite` と Origin 検査が複雑になる。
- API サーバーが静的ファイルも配信する（`@fastify/static`）: 構成は単純だが、静的ファイルの配信を API のタスクが担い、キャッシュも効かない。実装としては残っている（`dist/ui` があれば配信する）が、本番の経路としては使わない。

## 影響

### ポジティブ

- Cookie と Origin 検査を単純に保てる。
- 静的ファイルは CloudFront でキャッシュされ、API の負荷にならない。

### ネガティブ

- CloudFront の設定（ヘッダーの転送、キャッシュ無効）を誤ると、認証や SSE が壊れる。
- 既定の証明書のため、独自ドメインを持たない（`*.cloudfront.net`）。
- UI のビルド（`build:ui`）と S3 への配置が CI/CD に含まれていない。

## コンプライアンス

- `/api/*` のキャッシュが無効であること、転送ヘッダーに `Idempotency-Key` と `If-Match` が含まれること。
- ステージング環境で、作成・参加・SSE が CloudFront 経由で動くことを確認する。

## 備考

- 著者: claude-code（事後記録）。承認者: 未定
- 関連コミット: 5355ed4（`infra/main.tf` の初版）。U5 の入口の定義は未コミット
- 関連 ADR: ADR-004、ADR-006
