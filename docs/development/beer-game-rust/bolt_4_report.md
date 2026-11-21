---
type: Reference
title: "Bolt 4 終了報告 - コンテナ・デプロイの定義（Rust 版）"
description: "beer-game-rust の Bolt 4 の結果。実行イメージ、起動モード、SIGTERM、スモークテスト、Terraform の検証、サイズ・起動・メモリの記録。"
tags: [report, plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-21T08:08:52Z }
---

# Bolt 4 終了報告（Rust 版）

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B4（U1。[リリース計画](./release_plan.md)） |
| 期間 | 2026-11-21（1 セッション。計画は 2 稼働日。個別のステップ計画は作らず、リリース計画の完了条件に従った） |
| 状態 | **実装と記録は完了。人のゲートは未承認。AWS への適用はしていない（別のゲート）。** |

この報告は、実装の事実と、人が判断・検証すべき点を示すものです。**承認の記録ではありません。**

## 実施したこと

| 項目 | 結果 |
| :--- | :--- |
| 実行イメージ（RI1） | **distroless（`cc-debian12:nonroot`）・非 root・シェルなし**。ビルドは `rust:1.97.1-bookworm`。**46.4 MB**（実測。縮める前に、起動・メモリの実測を見る。RN1） |
| 起動モード | `api`（既定）・`migrate`（適用して終了コード 0）・`healthcheck`（RI3）。**設定の誤りは終了コード 78、未実装のモードは 64** |
| `healthcheck` サブコマンド | `/api/v1/health` を自分に問い合わせる（HTTP/1.0 を `TcpStream` で。追加の依存なし）。HEALTHCHECK がこれを使う |
| SIGTERM | `axum::serve().with_graceful_shutdown`。**`docker stop` で終了コード 0**（新しい要求の受付を止め、処理中の要求の完了を待つ）。コマンドは spawn したタスクが完了してから応答するため、完了待ちの対象になる |
| スモークテスト | `scripts/container-smoke.sh`。DATABASE_URL 無しは 78、未実装モードは 64、migrate は 0、HEALTHCHECK が healthy、実行ユーザーが nonroot、`/ready`・`/health` が 200、SIGTERM で 0。**ローカルで成功**。CI に `container` ジョブとして追加 |
| Terraform の定義の検証 | CI の `infra` ジョブ（Terraform 1.17.2、`fmt -check`・`init -backend=false`・`validate`。**適用しない**）。**成功**（手元の 1.5.7 では要件の 1.17 以上に満たず検証できなかったため、CI で初めて確認できた） |

## 記録（実測前に縮めない）

- イメージのサイズ: 46.4 MB。ビルド時間: 約 8 分（キャッシュなし）。
- 起動時間・メモリ: コンテナを起動して `healthy` になるまで、スモークテストの待ちの範囲内（数秒）。**メモリの実測はしていない**（B16 で記録）。
- タスクのサイズ（1 vCPU / 2 GiB の初期案）は変えていない。

## 人の判断が要る項目

1. 実行イメージの選択（distroless の `cc`）が RI1 の意図に合うか（静的リンク（musl）にして `scratch` にする案もある。サイズ・互換のトレードオフ）。
2. SIGTERM の完了待ちの上限（`stopTimeout` との関係）は、現状は上限を設けていない（タスクの完了を待つ）。運用手順書（B15）で決める。
3. AWS への適用（費用・アカウント・IAM）は、別のゲート。

---

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-21 | 初版作成（人のゲートは未承認） | claude-code |
