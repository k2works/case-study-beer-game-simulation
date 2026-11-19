---
type: Playbook
title: "デモ環境（Heroku）の運用手順書 - beer-game-kotlin"
description: "beer-game-kotlin を Heroku（Container Registry、Eco dyno、H2 のインメモリ）に配備し、関係者が画面を触って確かめるデモ環境を作る・更新する・止める手順。AWS の本番とは別。"
tags: [operation, heroku, demo]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-19T00:00:00Z }
---

# デモ環境（Heroku）の運用手順書

汎用の考え方は [Java アプリケーションデモ環境構築ガイド](../../reference/Javaアプリケーションデモ環境構築ガイド.md) による。本書は beer-game-kotlin の値と、ガイドとの差を書く。デモは関係者が画面を触って確かめるためのもので、**本番の代わりにしない**。AWS の本番・ステージング（[デプロイ手順書](./deploy.md)）とは別系統で、AWS には接続しない。

## 構成

| 項目 | 値 |
| :--- | :--- |
| 配備先 | Heroku（Common Runtime）、stack `container`、Container Registry、リージョン us |
| アプリ名 | `beer-game-kotlin-demo`（環境変数 `DEMO_APP` で替えられる） |
| URL | `https://beer-game-kotlin-demo-bc58641c42c0.herokuapp.com`（アプリ名に識別子が付く。`just demo-status` で確かめられる） |
| dyno | Eco（512 MB）、web 1 つ |
| データベース | H2 のインメモリ（再起動で初期状態に戻る） |
| 画面 | API と同じ URL から配信（同一オリジン。`WEB_ROOT`） |
| 配備 | CI の `deploy-demo` ジョブ（develop の push）。CI が使えないときは手元から |
| 認証（CI） | GitHub の Environment `demo`（配備のブランチを develop に限る）の secret `HEROKU_API_KEY` |
| 費用 | Eco の定額（月 5 USD、アカウントの全 Eco dyno に共通） |

> **注意**: URL を知っていればだれでも開ける前提。本物の参加者・実在の氏名を入れない。データは再起動で消える。

### ガイドとの違い

| ガイド（Spring Boot） | beer-game-kotlin |
| :--- | :--- |
| `SPRING_PROFILES_ACTIVE=dev` | `APP_ENV=local`。H2 を許すのは `APP_ENV=local` のときだけ（ADR-014）。`DB_KIND=h2`、`HOST=0.0.0.0` も Config Vars に置く |
| `bootJar`・`copyDemoLibs` | `:app:installDist` と `:app:copyDemoLibs`（H2 を `build/demo-lib` に写す。配布からは外したまま） |
| ステージ `build` / `runtime` / `demo` | `build` / `webbuild`（画面） / `base` / `demo` / `runtime`（最後。既定のターゲットは本番用のまま） |
| 起動 | demo は `java -cp "/app/lib/*:/app/demo-lib/*" beergame.app.MainKt api`（配布の起動スクリプトは H2 を外したクラスパスのため） |
| ヘルスチェック | `/api/v1/ready` が 200、`/` が 200、ゲームの作成（DB を使う操作）が 201 |
| 初期データ | 無い。ゲームは画面から作る |

`cookieSecure` は `APP_ENV=local` では false になる（デモは TLS を Heroku の Router が終端する。Cookie の `Secure` 属性は付かない）。機密のデータを入れない前提で受け入れる。

## 前提条件

| もの | 確かめ方 |
| :--- | :--- |
| Heroku のアカウントと Eco の契約 | Heroku の Billing で Eco dynos plan が有効 |
| Heroku CLI | `heroku --version` |
| Docker（buildx） | `docker buildx version` |
| GitHub CLI | `gh auth status` |
| just | `just --version` |

ログインは対話のため、人が行う。Container Registry の認証は Heroku CLI のログインとは別。

```bash
heroku login
heroku container:login
```

## タスク

`apps/beer-game-kotlin` で `just` を使う（中身は `scripts/demo.sh`）。独自の一時スクリプトは増やさない。

| タスク | 内容 |
| :--- | :--- |
| `just demo-setup` | アプリの作成と Config Vars の設定（冪等） |
| `just demo-deploy` | build → push → release（手元から。ガードつき） |
| `just demo-status` | dyno・Config Vars・URL |
| `just demo-restart` | 再起動（データは初期状態に戻る） |
| `just demo-stop` / `just demo-start` | 停止・再開 |

### 初回のセットアップ

```bash
just demo-setup
```

Config Vars: `APP_ENV=local`、`DB_KIND=h2`、`HOST=0.0.0.0`、`JAVA_TOOL_OPTIONS`（`-Xmx300m -XX:+UseSerialGC -Xss512k -XX:ReservedCodeCacheSize=64m -XX:MaxMetaspaceSize=192m`。512 MB の dyno に収める）。`PORT` は Heroku が設定する。`DEMO_REVISION` は配備のたびに入る。

### CI からの配備の準備

GitHub の Environment `demo` を作り、配備のブランチを develop に限る。

```bash
gh api -X PUT repos/k2works/case-study-beer-game-simulation/environments/demo \
  -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/k2works/case-study-beer-game-simulation/environments/demo/deployment-branch-policies \
  -f name=develop -f type=branch
```

Heroku の API キー（authorization）を作り、secret `HEROKU_API_KEY` に登録する。

```bash
# キーは標準出力に出さず、そのまま secret へ渡す（端末や履歴に残さない）。キーが空なら、登録しない
heroku authorizations:create --short -e 31536000 \
  -d "GitHub Actions beer-game-kotlin-demo deploy $(date +%F)" \
  | gh secret set HEROKU_API_KEY --env demo
```

- キーの説明に用途と作った日を入れる。キーが空なら登録しない（`Password required` で失敗した例がある）
- 期限の 2 週間前を期日にした更新の Issue を立てる。新しいキーで配備が通るのを確かめてから、古いキーを失効させる
- 漏えいの疑い: 新しいキーにして、すぐ古いキーを失効させる。`heroku releases` で覚えのない release がないか確かめる
- デモ環境をやめる: 説明が一致するキーを `heroku authorizations:revoke <ID>` で失効させ、`gh secret delete HEROKU_API_KEY --env demo`
- キーの境界は「develop に push できる人と AI のセッション」。`.github/workflows/` の変更は人がレビューする

## 配備

### CI から（通常）

develop への push で、CI の検証（contract・test・detekt・pmd・web・ui・container）がすべて緑になったあと、`deploy-demo` が配備する。手動で配備し直すときは、develop で CI を実行する。

```bash
gh workflow run beer-game-kotlin.yml --ref develop
gh run watch
```

`deploy-demo` の要点:

- Pull Request では動かさない。古い実行の再実行は、アプリを最後に変えたコミットが develop の先頭と違えば飛ばす
- `demo` ステージを `linux/amd64`・Docker v2 の manifest（`oci-mediatypes=false`）で作り、ラベルに `github.sha` を付けて push する
- Heroku Platform API で release し、`/api/v1/ready` と `/` が 200、ゲームの作成が 201 になるのを確かめてから `DEMO_REVISION` を入れる（release と Config Vars の変更は、それぞれ再起動を起こすため、続けて出さない）
- 確かめられなければ直前の release に戻し、ジョブを失敗にする（Eco には preboot がない）
- develop に push するたびに再起動し、データは初期状態に戻る。**デモの最中は develop に push しない**
- CI の配備の実行中は、手元で配備しない

### 手元から（CI が使えないとき）

```bash
just demo-deploy
```

次を確かめて止める: 作業ツリーに変更がない、develop にいて HEAD が `origin/develop` に含まれる、アプリを最後に変えたコミットの CI が success、push するイメージが HEAD から作ったもの（ラベル）。確かめを飛ばすときだけ `DEMO_SKIP_GUARD=1` を付け、理由を記録する。所要時間は、依存のキャッシュがあれば数分、初回は 6〜10 分。

## 確認

```bash
just demo-status
```

| 確かめること | 期待する結果 |
| :--- | :--- |
| URL を開く | https のまま、はじめる画面が開く |
| 画面の経路を直接開く（例: `/games/…/lobby`） | 画面が開く（`index.html`。存在しない `/api/...` と、拡張子つきのファイルは 404） |
| ゲームを作成し、参加コードで 4 役割が参加し、週を確定する | 最後まで進む |
| `/api/v1/ready` | 200 |
| `DEMO_REVISION` | 配備したコミット |

## 日常の運用

- ログ: `heroku logs --tail -a beer-game-kotlin-demo`。メモリは `log-runtime-metrics` で 20 秒ごとに出る（`sample#memory_total`）。450 MB を超えるか R14・R15 が出たら、所有者に諮る
- デモの前: `just demo-restart` で初期状態にし、数分前に一度開く（Eco は 30 分のアクセスなしでスリープし、最初のアクセスは遅い）
- ロールバック: `heroku releases -a beer-game-kotlin-demo`、`heroku rollback v<番号> -a beer-game-kotlin-demo`。戻せなければ、develop で `git revert` して配備する
- 停止・再開: `just demo-stop` / `just demo-start`
- 削除: 取り消せないため、タスクにせず、人が確かめてから `heroku apps:destroy -a beer-game-kotlin-demo --confirm beer-game-kotlin-demo`

## よくあるつまずき

| 症状 | 原因と対処 |
| :--- | :--- |
| `docker push` が `error from registry: unsupported` | OCI の media type で送っている。`oci-mediatypes=false`・`--provenance=false`・`--sbom=false` を付けて `buildx` で作る（`just demo-deploy` はそのとおり） |
| 起動で `H2 は APP_ENV=local のときだけ許される` | Config Vars の `APP_ENV` が `local` でない。`just demo-setup` で合わせる |
| 起動で `ClassNotFoundException: org.h2.Driver` | `runtime` のイメージを送った。`--target demo` で作る |
| 画面は開くが API が失敗する | `HOST=0.0.0.0` が無い（local の既定は 127.0.0.1）。`just demo-setup` で合わせる |
| `deploy-demo` が `Password required` か `unauthorized` | secret `HEROKU_API_KEY` が空か、期限切れ。登録し直し、`gh workflow run` で配備し直す |
| 古い実行を再実行したら警告で飛ばした | 仕様。新しい実行の結果を見る |
| 入れたデータが消えた | 仕様（H2 のインメモリ）。Heroku は dyno を 1 日 1 回以上再起動し、配備とスリープでも初期状態に戻る |

## 関連

- [Java アプリケーションデモ環境構築ガイド](../../reference/Javaアプリケーションデモ環境構築ガイド.md)
- [コンテナのローカル実行とスモークテスト](./container_local.md)
- [デプロイ手順書](./deploy.md)（AWS）
