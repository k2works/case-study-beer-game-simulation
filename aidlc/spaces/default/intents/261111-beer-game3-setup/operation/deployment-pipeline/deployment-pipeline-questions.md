# Deployment Pipeline 質問 - beer-game3

すでに決まっていること: beer-game3 専用の AWS 環境を用意する、`main` への merge で staging へ自動反映、production は手動承認、CI は `beer-game3.yml`（`gate` を通過したものだけ昇格）、成果物の置き場は AWS のレジストリ（ECR）を前提、アプリケーションは 1 つのプロセス（API、画面の配信、保持の定期処理）と PostgreSQL 18。実際の AWS の資源の作成は、次の Environment Provisioning の工程で、承認を得て行います。この工程は設計だけです。

## Q1. [運用] アプリケーションを動かす AWS の方式

アプリケーションは Node.js 26 の 1 プロセスで、PostgreSQL 18 に接続します。15 チーム・270 画面の取り直し（毎秒約 270 回）を支えます。

A. ECS（Fargate）+ ロードバランサー + RDS for PostgreSQL 18。コンテナの設定が細かく決められ、配備の安全装置（失敗時の自動の巻き戻し）が標準で使える。月額は最小構成で数十ドル規模になり、構成要素が多い
B. App Runner + RDS for PostgreSQL 18。構成が少なく、配備が簡単。ロードバランサーなどを自分で持たない。細かい調整（スケールの下限、ネットワーク）の自由度が低く、保持の定期処理を同じプロセスで動かす点の確認が要る
X. Other (please specify)

[Answer]: A

## Q2. [運用] 配備の戦略（staging と production）

保持の定期処理を同じプロセスで動かし、複数台のときはロックで 1 台だけが動く設計です。画面の取り直しが 1 秒おきのため、短い切り替えの途切れは再取得で吸収されます。データベースの移行は、前方にだけ進める（戻さない）方針を前提とします。

A. ローリング。1 台ずつ入れ替える。追加の費用がなく、切り替えの途切れが短い。新旧の版が一時的に混ざるため、移行は後方互換にする（拡張して縮小する）。失敗時は、直前のイメージの版へ自動で巻き戻す
B. Blue/Green。新しい環境を並べて切り替える。巻き戻しが即座。環境が一時的に 2 倍になり、データベースの移行との整合が難しい
X. Other (please specify)

[Answer]: A

## Q3. [運用] production の手動承認の方法

team の方針は、staging で確認したあと、手動承認で production へ配備することです。

A. GitHub の環境の保護（`production` 環境に必須のレビュアーを設定）。承認は GitHub 上で、あなたが行う。承認の記録が実行に残る。リポジトリの設定の変更を、承認を得て行う
B. 配備のワークフローを手動実行（`workflow_dispatch`）にして、実行者が承認を兼ねる。設定は少ないが、承認の記録が実行者の記録だけになる
X. Other (please specify)

[Answer]: A

## Q4. [プロダクト] 機能フラグ（段階的な公開）

beer-game3 は授業で使う小さなアプリケーションで、利用者の数は限られます。

A. 使わない。機能の有効・無効の切り替えは、配備の版で行う。仕組みが増えず、費用がかからない
B. AWS AppConfig の機能フラグを使う。配備と公開を分けられるが、仕組みと費用と運用が増える
X. Other (please specify)

[Answer]: A

## Consolidated Summary Confirmation

Does this all look correct before I generate the artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
