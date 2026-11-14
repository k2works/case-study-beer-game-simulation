---
type: Playbook
title: "コンテナのローカル実行とスモークテスト - beer-game-kotlin"
description: "ローカルの Docker で、コンテナをビルドしてスモークテスト（api・migrate・設定の拒否）を実行する手順。AWS には接続しない。"
tags: [operation, container, smoke-test]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-15T00:00:00Z }
---

# コンテナのローカル実行とスモークテスト

ローカルの Docker だけを使う。**AWS には接続しない。** CI の `container` ジョブも同じスクリプトを実行する。

## 前提

- Docker が動いている（`docker info` が成功する）。
- `openssl` と `perl`（ミリ秒の取得の代替）がある。スクリプトが、使い捨ての鍵とパスワードを実行のたびに作る（ファイルに残さない）。

## 実行

```bash
cd apps/beer-game-kotlin
./scripts/container-smoke.sh                       # イメージをビルドして検査する
SKIP_BUILD=1 IMAGE=beer-game-kotlin:smoke ./scripts/container-smoke.sh   # ビルド済みのイメージを使う
RUNS=7 ./scripts/container-smoke.sh                # 起動時間の計測の回数（既定 3）
```

PostgreSQL は、スクリプトが `postgres:18-alpine` のコンテナを専用のネットワークに起動し、終了時に片付ける。

## 確かめること

| 項目 | 期待 |
| :--- | :--- |
| api | PostgreSQL に接続し、`/api/v1/ready` が 200（本番相当の `APP_ENV=production`）。`/api/v1/health` も 200。HEALTHCHECK が healthy。SIGTERM で猶予内に終了 |
| migrate | マイグレーションを適用し、終了コード 0。適用の記録が残る |
| 秘密情報が無い | `APP_ENV=production` で秘密が無いと、終了コード 78 で起動に失敗。足りない設定の名前をログに出し、秘密の値は出さない |
| H2 の拒否 | `APP_ENV=production DB_KIND=h2` は終了コード 78。`local` の H2 も、ドライバが無く起動できない（終了コード 70） |
| 未実装のモード | `retention`・`rebuild-projections` は、未実装の旨を出して終了コード 69 |
| イメージの内容 | 非 root（uid 10001）で実行する |
| 起動時間 | コンテナの開始から `/ready` が 200 になるまで（マイグレーションの適用を除く）を計測して表示する |

## 所要の目安（ローカルの実測）

初回のビルドは約 6 分。`SKIP_BUILD=1`、`RUNS=1` のスモークテストは、2026-11-15 の実行で全項目が成功し、起動時間は 5775 ms（1 回。`docker run -d` の呼び出しを含む）だった。値は環境で変わる。NF-P16（p95 30 秒以下は提案）の判定には、複数回の計測が要る。

## 失敗したとき

- 失敗した項目は `FAIL :` で表示される。ログはスクリプトの出力で確認する。
- 名前にプロセス番号を含め、api のポートは 127.0.0.1 の空きポートへ割り当てる（固定のポートを使わない）。人の開発サーバー（3000・5173 など）とは衝突しない。中断した場合は、`bgk-` で始まるコンテナとネットワークが残っていないか `docker ps -a` で確認する。
