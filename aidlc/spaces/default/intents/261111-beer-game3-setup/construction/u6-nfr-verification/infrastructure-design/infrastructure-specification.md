# インフラストラクチャの仕様 - U6 u6-nfr-verification

U6 が必要とするインフラは、検証を動かす実行環境（GitHub Actions の実行機と、使い捨ての PostgreSQL）だけです。アプリケーションの稼働環境（staging、production の AWS）は、team の方針で beer-game3 専用に別に用意するもので、U6 の範囲に含めません（後の Operation で決める）。この文書は、`nfr-design` の `logical-components.md` が挙げた検証の部品を、実際に動かす場所に割り当てます。

出典: `nfr-design/` の 6 文書、`components.md`、`contract-summary.md`、`team.md` の Deployment と Code Style（Node.js 26、PostgreSQL 18、beer-game3 用に別に作る CI）、`apps/beer-game3/package.json` の npm scripts（`verify`、`typecheck`、`lint`、`format:check`、`test:coverage`）、リポジトリの設定（公開リポジトリ、既定の branch は `main`）。

**インフラの変更がある理由**: U1〜U5 では、このステージに該当するインフラの変更がなかった。`.github/workflows/` に beer-game3 用のワークフローはまだなく、U6 が初めて作る（`nfr-requirements` の Q7 の A）。

## 番号の付け方

`NFRn.m` は U6 の要件の番号である（U1〜U5 の同番号とは別の要件）。

## デプロイ

| 区分 | 選択 | 理由 |
| :--- | :--- | :--- |
| 計算の方式 | GitHub Actions の GitHub 提供の実行機（`ubuntu-24.04`）。アプリケーションは、ジョブの中で子プロセスとして起動する。アプリケーションのコンテナは作らない | 検証の期間だけ生きる使い捨ての環境で足りる。版を固定して `latest` を避け、実行環境の変化を要約で追跡する（NFR4.4） |
| 実行機の大きさ | 標準の実行機。リポジトリは公開のため、4 vCPU・16 GB の標準の実行機が使える（リポジトリの設定を確認済み）。負荷の生成、アプリケーション、PostgreSQL、Chromium が同居する | 15 チーム・75 台の本試験は単一のプロセスで足りる設計（`scalability-design.md`）。測定器の飽和（イベントループの遅れが 100 ミリ秒を超える）で「無効」になった場合の見直し先として、より大きな実行機を候補とする（費用が増えるため、そのときに判断する） |
| ネットワーク | すべての通信は実行機の内部（`localhost`）で閉じる。受け入れる通信（ingress）はない。外へ出る通信（egress）は、依存の取得（npm のレジストリ）、ブラウザの取得（Playwright の配布元）、GitHub の API とアーティファクトの保存に限る | 本番と staging に近づけない（NFR6.1） |
| 保存 | 実行機のディスクは使い捨て。成果物（要約、失敗時のトレースと画像）は GitHub Actions のアーティファクトに保存する。アプリケーションのデータは使い捨てのデータベースの中だけ | NFR2.2、NFR9.2、NFR9.3 |
| 環境 | CI（使い捨て）と、開発者の手元（ローカル）。staging と production は U6 に含めない | 検証は CI で行い、稼働環境は後の Operation（team の方針: staging は `main` への merge で自動反映、production は手動承認） |
| 環境の一致 | PostgreSQL は 18（team の方針で、本番と同じ版）、Node.js は 26（`.nvmrc` と team の方針）に揃える | 本番と同じ版で検証する |
| IaC の方式 | ワークフローの定義（YAML）をリポジトリに置く（`.github/workflows/beer-game3.yml`）。Terraform や CDK は使わない | 実行機は GitHub が提供する。AWS の IaC は稼働環境のために後の Operation で作る |
| 設定の保管 | シークレットは使わない。試験用のデータベースの接続情報は、使い捨てのサービスコンテナのための固定値で、ワークフローに書いてよい値である（NFR6.2） | シークレットがなければ、漏れる資格情報も、権限もない |
| 外部の動作（actions）の固定 | 使う actions（`actions/checkout`、`actions/setup-node`、`actions/upload-artifact`）は、完全なコミットの識別子で固定し、版をコメントに書く。識別子は Code Generation の時点で公式のリポジトリから確かめた（値は `cicd-pipeline.md` の「実装で決まった差」）。`actions/cache` は使わない（npm のキャッシュは `setup-node` で足りる） | 外部の変更を黙って取り込まない（NFR6.4 の考え方をワークフローにも適用） |

## インフラのサービス

| サービス | 役割 | 設定 | 備考 |
| :--- | :--- | :--- | :--- |
| PostgreSQL 18（サービスコンテナ） | データベース（試験用） | 公式のイメージ（`postgres:18.6` に固定）。`POSTGRES_USER` と `POSTGRES_PASSWORD` は使い捨ての固定値。健全性の確認（`pg_isready`）を待つ。ポートは実行機の内部だけに公開。データベースの作成と破棄は試験のスクリプトが行う（`Lifecycle`。NFR2.2） | ジョブごとに別のコンテナ。ジョブの終了で消える。データベースの管理に `CREATEDB` が必要なため、サービスコンテナの既定の管理用ロールを使う。負荷試験の整合性の検査（NFR2.1）は、この使い捨てのデータベースへ、読み取り専用のセッション（`default_transaction_read_only`）で接続して行う（`nfr-design/reliability-design.md`） |
| 実行機の Node.js 26 | 実行環境 | `actions/setup-node`（版 26、npm のキャッシュ） | `apps/beer-game3/package-lock.json` をキャッシュの鍵に使う |
| ブラウザ（Playwright） | 実ブラウザ（NFR8.1、NFR10.1、実ブラウザの測定） | Chromium、Firefox、WebKit は `npx playwright install --with-deps <ブラウザ>`、Edge は `msedge` のチャンネルで導入する。ジョブごとに必要なブラウザだけを入れる。ブラウザの取得物は、ロックファイルの内容を鍵にキャッシュする | Edge を ubuntu の実行機に導入できることは、Code Generation で公式情報により確かめる（`nfr-design` の確認事項） |
| アーティファクトの保存 | 成果物の保管 | 本試験の要約 30 日、短い負荷試験の要約 7 日、失敗時のトレースと画像 7 日（NFR9.2、NFR9.3） | 保持期間はワークフローの定義で指定し、定義の検査（Vitest）で確かめる |
| ジョブの要約（`GITHUB_STEP_SUMMARY`） | 結果の表示 | 閾値ごとの実測と合否の表（Markdown） | 成果物を開かずに読める |
| 必須のチェックの設定（リポジトリの設定） | 統合の保護 | `develop` と `main` の保護で、必須のチェックを集約のジョブ `gate` の 1 つだけにする（`verify`、`e2e`、`a11y`、`load-smoke`、`load-main` の結果は `gate` が判定する。行列のジョブ名や飛ばされたジョブの名前には依存しない。`cicd-pipeline.md`） | **リポジトリの設定の変更は外部への反映になる**。回答（Q1 の A）のとおり、設定する内容と戻し方を手順書に記録し、ワークフローが作られてチェックが一度動いて名前が確定した後、Code Generation の完了後に、あなたの承認を得てから設定する。それまでの間は、手元と PR の表示で確認する。ワークフローの条件で飛ばしたジョブは成功として扱われるため、アプリ以外の変更の PR が止まらない |

## 共有の資源

| 共有の資源 | 所有する Unit | 使う Unit | 境界 |
| :--- | :--- | :--- | :--- |
| `.github/workflows/beer-game3.yml` | U6 | U1〜U5 の既存の試験（`verify` ジョブが動かす） | U6 がワークフローを所有する。各 Unit の試験の追加は、`npm run verify` の中に入るだけで、ワークフローの変更を要しない |
| アーティファクトの保存 | U6 | なし | U6 の成果物だけ |

PostgreSQL のサービスコンテナはジョブごとに別で、Unit 間で共有しない。

## 上流の資料

`nfr-design/performance-design.md`、`security-design.md`、`scalability-design.md`、`reliability-design.md`、`observability-design.md`、`logical-components.md`、`components.md`、`contract-summary.md`
