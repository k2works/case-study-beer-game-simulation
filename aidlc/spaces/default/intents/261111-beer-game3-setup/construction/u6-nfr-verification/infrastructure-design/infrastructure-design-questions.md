# Infrastructure Design 質問 - U6 u6-nfr-verification

U6 の CI（`.github/workflows/beer-game3.yml`）の設計で、すでに決まっていることは質問しません。決まっていること: デプロイを含めない、`ubuntu-24.04` の標準の実行機（公開リポジトリのため 4 vCPU・16 GB）、PostgreSQL 18 のサービスコンテナ、シークレットなし、最上位の権限は `contents: read` だけ（NFR Requirements の Q7 の A と NFR Design の回答）。次の 2 点は、リポジトリの設定と依存の運用に関わり、あなたの判断が要ります。

## Q1. [運用] 統合の保護（必須のチェック）の設定の進め方

`develop` と `main` を守るには、GitHub のリポジトリの設定で `verify`、`e2e`（4 ブラウザ）、`a11y`、`load-smoke` を「必須のチェック」にする必要があります（`main` への PR では `load-main` も）。これはワークフローの定義ではなく、リポジトリの設定の変更です。設定を誤ると、ほかのアプリ（beer-game2 など）の PR も止まる恐れがあります。ただし、アプリ以外の変更では beer-game3 のジョブを飛ばす作りにするため、飛ばしたジョブは成功と扱われ、止まりません。

A. ワークフローの作成が済んで、チェックが一度動いた後に、設定する内容を手順書に書き、設定は Code Generation の完了後に、あなたの承認を得てから行う。チェックの名前が確定してから設定するため、名前の食い違いで統合が止まるのを避けられる。設定を行うまでの間、必須のチェックは手元と PR の表示で確認する運用になる
B. 設計だけ記録し、設定は手順書を渡して、あなたが自分で行う。設定の変更に AI が関わらず、外部の設定を誤らない。ただし、設定を忘れると保護が効かないまま残る
X. Other (please specify)

[Answer]: A

## Q2. [運用] 外部の actions（`actions/checkout` など）の更新の方法

ワークフローが使う外部の actions は、完全なコミットの識別子で固定します（外部の変更を黙って取り込まないため）。固定すると、更新を自分で追う必要があります。

A. 固定したうえで、更新は人が確認して手作業で行う。依存の自動更新の設定を足さないため、リポジトリに新しい設定ファイルが増えない。更新を忘れると、古い版が残る
B. 固定したうえで、依存の自動更新（Dependabot）の設定を `.github/dependabot.yml` に足し、actions の更新の PR を自動で受け取る。更新を見落としにくいが、新しい設定ファイルと、更新の PR を確認する手間が増える
X. Other (please specify)

[Answer]: A

## Consolidated Summary Confirmation

Does this all look correct before I generate the artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
