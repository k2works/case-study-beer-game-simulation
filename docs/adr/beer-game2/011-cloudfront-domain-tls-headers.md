---
type: ADR
title: "ADR-011: 独自ドメイン、TLS 1.2 以上、セキュリティヘッダーを含む CloudFront の単一オリジンにする"
description: "Web と API を CloudFront の単一オリジンで配信する構成を引き継ぎ、独自ドメインと ACM の証明書、TLS 1.2 以上、レスポンスヘッダーポリシー（CSP、HSTS など）を加える。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-09T09:01:21Z }
---

# ADR-011: 独自ドメイン、TLS 1.2 以上、セキュリティヘッダーを含む CloudFront の単一オリジンにする

Web と API を CloudFront の単一オリジンで配信する構成を引き継ぎ、独自ドメインと ACM の証明書、TLS 1.2 以上、レスポンスヘッダーポリシー（CSP、HSTS など）を加える。

日付: 2026-11-09

## ステータス

提案中（レビュー待ち）

## コンテキスト

v1 の ADR-007 は、CloudFront の単一オリジンを決めたが、既定の証明書で、TLS の最低版を指定できず、セキュリティヘッダーも設定されていなかった。非機能要件では、TLS 1.2 以上と、CSP・HSTS・`nosniff` を求めている。

## 決定

- CloudFront を唯一の入口とし、既定は非公開の S3（OAC）、`/api/*` はキャッシュなしで ALB へ。
- **独自ドメインと ACM の証明書を使い、TLS 1.2 以上を指定する。**
- **CloudFront のレスポンスヘッダーポリシーで、CSP、HSTS、`nosniff`、Referrer-Policy を付ける。** アプリ（`@fastify/helmet`）でも、API の応答に付ける。
- `/api/*` では、Cookie、クエリ、`Origin`、`Referer`、`Idempotency-Key`、`If-Match` を転送する。
- WAF は、必要になった時点で導入する。

### 代替案

- 既定の証明書のまま（v1）: TLS の最低版を指定できない。
- Web と API を別のドメインにする: Cookie（`SameSite=Strict`）と Origin 検査が複雑になる。

## 影響

### ポジティブ

- TLS の最低版とセキュリティヘッダーの要件を満たす。
- Cookie と Origin 検査を単純に保てる。

### ネガティブ

- 独自ドメインの取得と、DNS の管理が必要になる。
- CSP の設定を誤ると、画面が壊れる（段階的に導入する）。

## コンプライアンス

- TLS 1.2 未満の接続が拒否されること。
- 応答に、CSP、HSTS、`nosniff`、Referrer-Policy が付くこと（ヘッダーの検査）。

## 備考

- 著者: claude-code
- 関連 ADR: v1 の [ADR-007](../beer-game/007-cloudfront-single-origin.md)（引き継ぎ、拡張）
- 参照: [インフラ（v2）](../../design/beer-game2/architecture-infrastructure.md)
