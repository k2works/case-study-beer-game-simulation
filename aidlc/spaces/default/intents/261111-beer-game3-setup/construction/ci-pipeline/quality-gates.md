# 品質ゲート - beer-game3

merge と昇格を止める条件と、その強制の仕組みです。強制は `beer-game3.yml` の各ジョブと、集約のジョブ `gate` が行います。

## ゲートの一覧

| ゲート | 条件 | 強制するもの | 失敗の扱い |
| :--- | :--- | :--- | :--- |
| 整形・lint・型検査 | `format:check`、`lint`、`typecheck` が成功 | `verify` | merge しない（team の規則） |
| 試験とカバレッジ | 全試験が成功、行のカバレッジ 80% 以上（閾値は下げない） | `verify`（`test:coverage`） | merge しない |
| 再現性 | 既知系列の golden test（50 週）が成功 | `verify` | merge しない |
| 画面の試験 | キーボードの通し、主要な操作が 4 ブラウザで成功 | `e2e` | merge しない |
| アクセシビリティ・日本語 | axe-core の違反 0 件、状態の表示、日本語表示 | `a11y` | merge しない |
| 短い負荷試験 | 取り直し 95 パーセンタイル 500 ミリ秒以内、サーバーの異常・タイムアウト・接続失敗 0 件、整合性の崩れ 0 件。「無効」も失敗 | `load-smoke` | merge しない |
| 本試験 | 入力 1 秒、反映 2 秒、取り直し 500 ミリ秒（最大想定 1 秒）、異常 0 件、整合性 0 件 | `load-main`（`main` への PR では必須） | `main` へ merge しない |
| 依存 | 検証の依存が本番の依存に含まれない、版が固定 | `verify` | merge しない |
| 集約 | 上のゲートの結果が `gate` で判定される。`changes` の失敗も失敗 | `gate`（必須のチェックはこれだけ） | merge しない |

## ゲートの原則

- 閾値は緩めない。超過は原因を切り分けて直す。再実行で通ったことを合格にしない。
- 必須のチェックの設定（リポジトリの設定）は、あなたの承認を得てから行う。設定するまでは、PR の表示と手元の `npm run verify` で確認する運用になる。
- デプロイの昇格のゲート（staging の自動反映、production の手動承認）は Deployment Pipeline で決める。

## U6 のレビューの指摘と対応

| 指摘 | 重大度 | 状態 |
| :--- | :--- | :--- |
| 接続先の検査の穴（ホストのない接続文字列と実行環境の `PGHOST`） | Major | **修正済み**。ホストも `host=` もない接続文字列を拒否し、親のプロセスの `PGHOST`、`PGHOSTADDR`、`PGSERVICE` が外部を指すとき拒否する（`verification/shared/target-guard.ts`、試験 `tests/u6/features/safety.spec.ts`）。`PGHOST=evil.example.com` の実行が、接続前に終了コード 2 で拒否されることを確認 |
| キーボード試験の抜け道 | Major | **修正済み**。代替の選択（`selectOption`）を macOS に限り、Linux と Windows では矢印キーで値が変わらなければ失敗させる（`verification/shared/platform.ts`）。Linux での実際の動作は、最初の PR の CI（`e2e (chromium / firefox / webkit / edge)`）で確かめる |
| 残りの指摘 | Minor | 下の表のとおり未解決 |
| Playwright の実行器の環境 | Minor | 親の環境（`DATABASE_URL`、`PG*`）を引き継ぐ。許可リストの環境を渡すか、設計に記録する |
| `color-contrast` の判定 | Minor | `incomplete` だけでも通る。`passes` を要求する |
| 英語の検出 | Minor | 3 語以上の並びだけ。限界を明記し、2 語以上も検出する |
