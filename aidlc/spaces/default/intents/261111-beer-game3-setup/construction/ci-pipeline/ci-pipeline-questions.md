# CI Pipeline 質問 - beer-game3

すでに決まっていることは質問しません。決まっていること: CI のツールは GitHub Actions（`.github/workflows/beer-game3.yml` を U6 で作成済み）、ブランチの方針は `develop` で統合し `main` はリリース時の merge（team の方針）、merge 前の必須のチェックは集約のジョブ `gate` の 1 つ（設定は承認を得て行う）、品質の基準は型検査・lint・整形・カバレッジつきの試験・golden test・画面の試験・短い負荷試験。

## Q1. [運用] 成果物（アプリケーションのコンテナのイメージ）の置き場

beer-game3 には Dockerfile も、イメージを作って公開する仕組みもまだありません。既存の `docker-publish.yml` は別のアプリ用で、GitHub のレジストリ（ghcr.io）にタグで公開しています。team の方針は、beer-game3 専用の AWS 環境を用意し、`main` への merge で staging へ自動反映、production は手動承認です。

A. 次の Deployment Pipeline の工程で、AWS のレジストリ（ECR）を前提に決める。この CI の工程では、イメージを作らず、公開もしない（CI は検証だけ）。置き場は、AWS 環境の設計（Environment Provisioning）と合わせて決められる
B. GitHub のレジストリ（ghcr.io）を使う。既存の仕組みに近いが、AWS の環境がイメージを取得する認証が別に要る
X. Other (please specify)

[Answer]: A

## Q2. [品質保証] Construction から Operation へ進む前の確認で、網羅が不合格のときの扱い

Build and Test の全 Unit の網羅の確認で、機能要件と受入条件はすべて網羅されましたが、非機能要件（NFR）の詳細の一部（主に U3 と U5）が、その Unit のコード生成の追跡表に実装の対象として載っていません。実際には試験があるものが多い見込みですが、機械は網羅と認めません。この工程の確認は、未解決の項目が残っていると、Operation への移行を止める決まりです。

A. 不合格のまま、記録して先へ進む。未解決の項目を一覧にして `phase-check-construction.md` に残し、後の工程（性能・稼働後の検証）に引き継ぐ。確認の結果を「条件つきの合格」とする。追跡表の補完は後回しになる
B. 先に追跡表を補う。U3 と U5 などの追跡表を、実際の試験に対応づけて書き直し、網羅の確認を通してから先へ進む。時間はかかるが、確認が合格になる
X. Other (please specify)

[Answer]: A

## Consolidated Summary Confirmation

Does this all look correct before I generate the artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
