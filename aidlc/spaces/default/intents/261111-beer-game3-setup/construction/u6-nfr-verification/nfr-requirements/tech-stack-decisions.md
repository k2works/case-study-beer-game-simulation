# 技術スタックの決定 - U6 u6-nfr-verification

U6 が検証のために使う技術の選択と理由です。アプリケーションの技術スタックは、U1 の決定（`tech-stack-decisions.md`）をそのまま引き継ぎ、変えません。ここに書くのは、U6 が追加で使う試験と CI の技術だけです。

出典: `requirements.md`（NFR3、NFR8、NFR10、NFR11）、`team.md` の Code Style と Deployment（Node.js 26、PostgreSQL 18、beer-game3 用に別に作る CI）、`technology-stack.md`（beer-game2 の構成。参考）、`nfr-requirements-questions.md`（Q2、Q4、Q5、Q7）。

版は、U1 の決定にある候補の値を載せています。npm や公式サイトでの再確認はまだしていません。Code Generation の時点で、公式情報で確かめ、サポート期限を確認して決めます。

## 決定

| 区分 | 選択 | 候補の版 | 理由 | 関連する要件 |
| :--- | :--- | :--- | :--- | :--- |
| 負荷試験 | リポジトリ内の Node.js のスクリプト（標準の `fetch` と `node:perf_hooks` を使い、Vitest の外で単独で動く） | - | 依存を増やさず、CI で動かせる。短い試験と本試験を同じスクリプトと設定値で動かせる（Q2 の A） | NFR3.1〜NFR3.5、NFR4.3 |
| 画面の通し試験・ブラウザの試験 | Playwright（Chromium、Firefox、WebKit、Edge の安定版） | 1.65.0（U1 の候補） | キーボード操作の再現と、複数のブラウザでの同じ試験の実行ができる。U1 の技術スタックで候補としていた（Q4 の A） | NFR8.1、NFR10.1 |
| アクセシビリティの検査 | axe-core と、その Playwright 用の連携 | 4.14.0（U1 の候補）。連携の版は Code Generation で確認 | WCAG 2.2 AA の違反を自動に検出できる（Q5 の A） | NFR8.2 |
| 色の比の計算 | リポジトリ内の関数（色の値からコントラスト比を計算する） | - | axe-core が測れない文字以外の要素（グラフの線と印）の比を、依存を増やさずに確かめる | NFR8.3 |
| 日本語表示の検査 | Vitest の検査と Playwright の検査（新しい依存なし） | - | 画面の文言の一覧の検査と、表示された文言の検査（Q5 の A） | NFR11.1 |
| CI | GitHub Actions（beer-game3 専用の `.github/workflows/beer-game3.yml`）、ubuntu の実行環境、PostgreSQL 18 のサービスコンテナ | - | team の方針（beer-game3 用に別に作る）。既存の `beer-game-u1.yml` と `beer-game2*.yml` は別のアプリ用で、再利用しない（Q7 の A） | NFR3.5、NFR6.2 |
| 試験用のデータベース | PostgreSQL 18（使い捨てのコンテナ） | 18 | team の方針。本番と同じ版で検証する | NFR2.2、NFR6.1 |

## 方針

- アプリケーションの依存は増やさない。追加は dev の依存だけ（Playwright、axe-core とその連携）で、本番の成果物に含めない（NFR6.4）。
- Playwright と axe-core は、U1 の決定で候補としたもので、`apps/beer-game3/package.json` にはまだ入っていない。導入は、U6 の Code Generation の計画の承認を経て行う。版を固定し、導入前に配布元と既知の脆弱性を確かめる（NFR6.4）。
- CI は、デプロイを含めない（Q7 の A）。staging と production のワークフローは、後の Operation で作る。
- 負荷試験のスクリプトは、アプリケーションの内部を import せず、負荷をかけるのは HTTP の公開の面だけにする。内部の実装が変わっても、同じ試験で測れるようにするためである。例外は、負荷試験の終了時の整合性の検査（`reliability-requirements.md` の NFR2.1）で、試験用のデータベースへの読み取り専用の接続を使う。アプリケーションの起動とデータベースの作成・破棄は、スクリプト自身が行う（NFR2.2）。

## 却下した案

- k6: 負荷の形の記述と集計は整うが、npm の外のバイナリで、CI と開発者の端末への導入が増え、別の実行環境の書き方になる。標準の機能で足りる規模のため、却下した（Q2 の B）。
- 古い版の Playwright を別に固定して、1 つ前の世代も自動で確かめる案: 依存の版が 2 本になり保守が増えるため、却下した。1 つ前の世代は確認票で確かめる（Q4 の B）。
- スクリーンリーダーと拡大表示の手動の確認票: 手作業が増えるため、範囲に含めない（Q5 の B）。

## 上流の資料

`requirements.md`、`technology-stack.md`、`nfr-requirements-questions.md`
