# Build and Test の要約 - beer-game3

## 全体の状態

| 項目 | 状態 |
| :--- | :--- |
| ビルド | 成功（`tsc` と `vite build`） |
| 試験 | 失敗 0 件。959 件（84 ファイル）、画面 68 件（Chromium 65、Firefox 2、WebKit 1）、短い負荷試験と本試験が合格。行のカバレッジ 94.5%（閾値 80%） |
| 目標の判定 | `Not Met` 0 件。`Unverified` が下の表のとおり残る（手元で実行できないもの。担当の工程が後にある） |
| 全 Unit の網羅 | FR と AC はすべて網羅。NFR の詳細の一部が「未実装」として残る（`cross-unit-traceability.md`） |

Build and Test の失敗の判定（コマンドの失敗、`Not Met`、`Unverified` のいずれか）に従うと、`Unverified` が残るため、この段階は「成功」と言えない。この点は承認の場でお知らせする。

## 試験の種類の一覧

| 種類 | 手順書 |
| :--- | :--- |
| ビルド | `build-instructions.md` |
| 結合 | `integration-test-instructions.md` |
| 性能 | `performance-test-instructions.md` |
| セキュリティ | `security-test-instructions.md` |
| 各 Unit の単位試験 | `construction/<unit>/code-generation/unit-test-instructions.md` |

## Unit ごとのカバレッジ

行のカバレッジは全体（`src/**`）で 94.5%。Unit 別の閾値はなく、全体の閾値 80% を満たす。U6 の `verification/` は計測の対象外（型検査、lint、整形と、U6 の試験で保つ）。

## Target Verification Matrix

出典は、各 Unit の `nfr-requirements/` と `nfr-design/`、各 `code-generation-plan.md` の Testing Contract。同じ種類の目標は 1 行にまとめた（詳細な ID は各 Unit の文書）。ID の「U1:」などは Unit。

| Target ID | Source | Expected | Actual | Evidence | Owning Stage | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| C-ALL | 各 Unit の Testing Contract | 行のカバレッジ 80% 以上 | 94.5% | `npm run verify`（`test-results.md`） | build-and-test | Met |
| CI-ALL | Testing Contract の「CI で動かす」 | 試験を CI で動かしてから merge | CI は ci-pipeline で整える | - | ci-pipeline | N/A（CI Pipeline は後の工程。そこで CI が試験を動かす） |
| U1:NFR3.1 / U6:NFR3.1 | `u1`・`u6` perf | 入力の確定の応答 95 パーセンタイル 1 秒 | 243 ミリ秒（600 件） | 本試験 `main-run.log` | build-and-test | Met |
| U1:NFR3.2 / U6:NFR3.2 | 同上 | 週確定後の反映 2 秒 | 仮想 955 ミリ秒（560 件）、実ブラウザ 721 ミリ秒（50 件） | 同上 | build-and-test | Met |
| U1:NFR3.4 / U6:NFR3.3 | 同上 | 取り直し 通常 500 ミリ秒、最大想定 1 秒 | 174 ミリ秒、647 ミリ秒（99 パーセンタイル 1038 ミリ秒） | 同上 | build-and-test | Met |
| U1:NFR3.3 | `u1` perf | 週確定の処理 500 ミリ秒（50 週のゲームの任意の週） | 単位・結合の試験が通過 | `npm run verify` | build-and-test | Met |
| U1:NFR3.7 | `u1` perf | 書き込みの順番待ち 3 秒、超えたら 503 | 結合の試験が通過。負荷でも 503 は 0 件 | 同上、本試験 | build-and-test | Met |
| U6:NFR3.4 | `u6` perf | サーバーの異常・タイムアウト・接続失敗 0 件 | すべて 0 件 | 本試験 | build-and-test | Met |
| U1:NFR4.1〜4.4 / U6:NFR4.x | `u1`・`u6` scal | 15 チーム、75 台と 270 台、書き込みが読み取りを待たせない | 本試験が通過 | 本試験 | build-and-test | Met |
| U3:NFR3.1〜3.4 | `u3` perf | 運営操作 1 秒、運営の画面 500 ミリ秒（最大 1 秒）、履歴 1000 件 1 秒、反映 2 秒 | 試験が通過。負荷試験は運営操作を直接は測らない（確定と取り直しのみ） | `npm run verify`、本試験 | build-and-test | Met（単位・結合の試験で。負荷の下での運営操作の応答は未計測 → 下の行） |
| U3:NFR3.x（負荷の下） | `u3` perf | 負荷の下での一時停止・再開・終了の応答 | 負荷試験の動作に含まれていない | - | performance-validation | Unverified |
| U4:NFR3.1〜3.5 | `u4` perf | 観察者と小売店の取り直し 500 ミリ秒、参加 1 秒、再接続 1 秒 | 試験が通過。観察者の取り直しは負荷試験に含まれていない（観察者 1 人は参加するだけ） | `npm run verify` | build-and-test | Met（単位・結合）。負荷の下の観察者は Unverified（performance-validation） |
| U5:NFR3.1〜3.5 | `u5` perf | 結果 1 秒、出力 2 秒、保持処理 1 ゲーム 1 秒 | 50 週のゲームの応答の試験が通過 | `tests/u5/features/performance.spec.ts` | build-and-test | Met |
| U1:NFR6.x、U3:NFR6.x、U4:NFR6.x、U5:NFR6.x | 各 `sec` | 認可、情報の分離、総当たりの制限（10 回/分）、ハッシュ保管、検証、ヘッダ | 認可の網羅の試験を含め通過 | `npm run verify` | build-and-test | Met |
| U1:NFR6.6、U4:NFR6.6 | `sec` | HTTPS のみ、プロキシの段数 | 稼働環境の設定 | - | environment-provisioning、deployment-pipeline | Unverified |
| U1:NFR2.x、U3:NFR2.x、U4:NFR2.x、U5:NFR2.x | 各 `rel` | 単一のコミット、版の検査、冪等、原子性、失敗の注入 | 結合の試験が通過 | `npm run verify` | build-and-test | Met |
| U1:NFR1.1、U2、U6:NFR1.x | `rel` | 同じ入力から同じ結果（50 週の golden）、同じ種で同じ要求の列 | 通過 | `tests/u2/features/golden-50-weeks.spec.ts`、`tests/u6/unit` | build-and-test | Met |
| U1:NFR5.x、U4:NFR5.x | `rel` | 再起動の復元、30 分の切断から復帰、token 24 時間 | 結合の試験が通過 | `tests/u4/integration/restart-pg.spec.ts` ほか | build-and-test | Met |
| U5:NFR7.1〜7.2 | `sec` | 31 日後の削除、7 日設定で 8 日後の削除、自動終了 30 日 | 時刻を注入した試験が通過 | `tests/u5/features/retention.spec.ts` | build-and-test | Met |
| U5:NFR7.3 | `sec` | ログとバックアップの保持 30 日以内 | 稼働環境の設定 | - | environment-provisioning、observability-setup | Unverified |
| U1:NFR3.5、3.6、U3:NFR9.x、U4:NFR9.x、U5:NFR9.x | `obs` | リクエストの識別子、構造化ログ、健全性、履歴 | 通過 | `npm run verify` | build-and-test | Met |
| U6:NFR8.1 | `u6` perf | キーボードだけで 6 画面を通す | Chromium と Firefox で通過。WebKit と Edge は未実行 | 画面の試験 | build-and-test、ci-pipeline | Met（Chromium、Firefox）。WebKit と Edge のキー操作は Unverified（ci-pipeline） |
| U6:NFR8.2 | `u6` perf | WCAG 2.2 AA の違反 0 件（全画面・全状態） | 20 状態で 0 件（`color-contrast` が動いたことは `passes` ではなく和集合で確認。レビューの Minor） | Chromium の画面の試験 | build-and-test | Met |
| U5:NFR8.1、U6:NFR8.3 | 同上 | 文字 4.5:1、グラフの系列 3:1 | 4 色とも 3:1 以上 | `tests/u6/unit/summary-contrast-language.spec.ts` | build-and-test | Met |
| U6:NFR8.4 | 同上 | 状態を色だけに頼らず示す | 通過 | `verification/e2e/status-indication.e2e.ts` | build-and-test | Met |
| U6:NFR10.1 | 同上 | 最新の 4 ブラウザで主要な操作 | Chromium、Firefox、WebKit で通過。Edge は未実行 | 画面の試験 | ci-pipeline | Unverified（Edge）。ほかは Met |
| U6:NFR10.2 | 同上 | 1 つ前の世代と実機の Safari の確認票 | 未記入（リリース 0.1 の欄は「未確認」） | `docs/operation/beer-game3/release-checklist.md` | deployment-execution | Unverified |
| U5:NFR11.x、U6:NFR11.x | 同上 | 日本語のみ（`messages.ts` と表示）、出力の説明 | 通過。ただし英語の検出は 3 語以上の並びのみ（レビューの Minor） | `verification/e2e/japanese.e2e.ts`、`tests/u6/unit` | build-and-test | Met |
| U6:NFR6.1〜6.4、7.x | `u6` sec | 接続先の制限、権限、秘匿、依存の固定、成果物の保持 | 定義と試験が通過。ただし `PGHOST` の穴と実行器の環境の引き継ぎが未解決（レビューの指摘） | `tests/u6` | build-and-test | Met（既知の指摘あり） |
| U6:NFR9.1〜9.4 | `u6` obs | 要約 JSON、保存日数、失敗時の成果物、確認票 | 要約の形の試験が通過。保存日数は定義の検査のみ | `tests/u6/unit` | ci-pipeline | Unverified（CI 上の保存の動作） |
| U6:CI 動作 | `u6` infra | `gate`、並行実行、保持日数、`msedge` の導入、Node.js 26 の `setup-node` | 定義の検査のみ。実行は未確認 | `tests/u6/unit/ci-*.spec.ts` | ci-pipeline | Unverified |

## 準備の状態

| 区分 | 状態 |
| :--- | :--- |
| build-ready | はい |
| test-ready | はい（Edge、WebKit のキー操作は CI） |
| deployment-ready | いいえ（CI、稼働環境、デプロイのワークフローがまだない。後の工程） |

## 既知の制約と未解決

- `Unverified` の目標が、ci-pipeline、performance-validation、environment-provisioning、deployment-pipeline、deployment-execution に引き継がれている（上の表）。
- 全 Unit の網羅の確認で、NFR の詳細の一部が「未実装」（`cross-unit-traceability.md`）。
- U6 のレビューの未解決の指摘: 接続先の検査の穴（Major）、キーボード試験の抜け道（Major）、Minor 3 件。
- 設計文書（`cicd-pipeline.md`）の `gate` の起動の種類ごとの判定は、実装と一致するよう反映済み。
