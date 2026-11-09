---
type: ADR
title: "ADR-003: ドメインモデル + ポートとアダプターを採用し、層の依存を lint で守る"
description: "バックエンドを、ドメインを中心に置くポートとアダプターとし、ルールは集約が持ち、層の依存の向きを、lint で機械的に守る。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-09T09:01:19Z }
---

# ADR-003: ドメインモデル + ポートとアダプターを採用し、層の依存を lint で守る

バックエンドを、ドメインを中心に置くポートとアダプターとし、ルールは集約が持ち、層の依存の向きを、lint で機械的に守る。

日付: 2026-11-09

## ステータス

提案中（レビュー待ち）

## コンテキスト

v1 は、ルールが `GameService`（約 650 行）に集中し、`domain/` は週次計算しか持たなかった。`api/app.ts`（約 560 行）には、ルート、認証、SSE、出力が同居していた。変更理由が複数あり、規則の変更が 1 か所に集まり、読みにくい。

## 決定

- 構造は、ドメインモデル + ポートとアダプター（`domain/`、`ports/`、`application/`、`adapters/http`、`adapters/persistence`）とする。
- **業務ルールは集約（`Game`、`Session`、`RetentionSaga`）が持つ**。アプリケーション層は、集約の読み込み、呼び出し、保存だけを行う。
- `domain/` は、他のどの層も import しない。依存は、外側から内側への一方向。
- この規則は、ESLint の `no-restricted-imports`（標準のルール）で検査し、違反は CI で失敗させる（依存関係を追加しない）。
- HTTP のルートは、機能別（games、participation、session、learning、retention、health）に分ける。

### 代替案

- v1 と同じ構造（サービスにルールを集中）を続ける: 貧血なドメインモデルと、巨大なサービスが残る。
- クリーンアーキテクチャの厳密な 4 層: 本システムの規模では、ポートとアダプターで足りる。
- 層の依存を、レビューだけで守る: 違反が見逃され、劣化する。

## 影響

### ポジティブ

- 規則の変更が、集約に集まる。ドメインをユニットテストで網羅できる。
- 層の依存が、機械的に守られる。

### ネガティブ

- 初期の構造の整備に、工数がかかる。
- 集約の設計（粒度）を、誤ると、直すコストが高い。

## コンプライアンス

- `domain/` が `application/`、`adapters/` を import しないこと（lint）。
- アプリケーション層に、業務ルール（条件分岐による検証）が増えていないこと（レビュー）。

## 備考

- 著者: claude-code
- 関連 ADR: [ADR-004](./004-separate-game-and-session-aggregates.md)
- 参照: [バックエンドアーキテクチャ（v2）](../../design/beer-game2/architecture-backend.md)、[ドメインモデル（v2）](../../design/beer-game2/domain-model.md)
