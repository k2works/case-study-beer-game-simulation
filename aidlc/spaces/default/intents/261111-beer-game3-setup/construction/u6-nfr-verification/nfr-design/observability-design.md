# 可観測性の設計 - U6 u6-nfr-verification

U6 の可観測性は、「検証の結果を、後から読めて比べられる形で残す」ことに限ります。アプリケーションの運用の監視（メトリクスの保存先、警告のしきい値、通知先）は、後の Operation で決めるため、ここでは新しい仕組み（ダッシュボード、メトリクスの保存先）を足しません。

出典: `observability-requirements.md`（NFR9.1〜NFR9.4）、`performance-requirements.md`、`security-requirements.md`、`reliability-requirements.md`。

## 番号の付け方

U6 の `NFR9.x` は、上流の NFR9（操作の履歴の監査性。u3-facilitation）とは別で、U6 の検証の結果を追跡できるようにする要件である。

## 結果の要約（JSON）の設計

負荷試験は、終了時に 1 つの JSON を標準出力の最後の行と、ファイル（`verify-summary.json`）に出す。

| 欄 | 内容 |
| :--- | :--- |
| `schemaVersion` | 要約の形の版（整数。形を変えたら上げる） |
| `startedAt` / `finishedAt` | 実行の日時（UTC の ISO 8601） |
| `revision` | 検査したコミットの識別子と branch 名（CI は環境変数から。取れなければ `unknown`） |
| `config` | チーム数、画面の数、各区間の時間、確定の頻度、種、外部接続で実行したか |
| `environment` | CPU の数、メモリの量、OS、Node.js と PostgreSQL の版、実行場所（CI かローカルか） |
| `phases` | 区間ごと（`warmup`、`normal`、`peak`）に、指標ごとの件数、50、95、99 パーセンタイル（ミリ秒）。入力の確定、反映（仮想の利用者）、取り直し、反映（実ブラウザ。本試験のみ）。取り直しは予定時刻から測った値で、`behind`（遅れの累積の回数）も出す |
| `errors` | 状態コードの集計。5xx の件数、`unavailable`（503）の件数、`rate_limited` の件数、`connect`（接続の失敗）の件数、`timeout`（5 秒）の件数、`reflectionMissing`（10 秒たっても新しい週が現れなかった画面の数） |
| `consistency` | 整合性の検査の結果（検査したゲーム数、崩れた件数、崩れたゲームと週の識別子） |
| `harness` | 測定器のイベントループの遅れ（99 パーセンタイル）、飽和の判定 |
| `thresholds` | 閾値ごとに、名前、値、実測、合否、判定に使ったか（短い試験の記録のみの指標は `recordedOnly: true`）。本試験の名前は `inputConfirmP95`、`reflectionVirtualP95`、`reflectionBrowserP95`、`pollNormalP95`、`pollPeakP95`、`serverErrors`、`timeouts`、`connectFailures`、`consistency` |
| `verdict` | `pass`、`fail`、`invalid` と、`invalid` の理由 |

**書かない項目**: 参加コード、進行役用コード、復帰用 token、接続文字列、環境変数の値。許可リスト方式で項目を書き、それ以外は書けない作りにする（`security-design.md`）。要約の形の試験で、必須の欄の存在と、秘匿の対象の値が含まれないことを確かめる。

## 構造化ログ（負荷試験のスクリプト）

標準エラー出力に 1 行 1 件の JSON で出す。標準出力は要約の最後の行に使う。

| 事象 | 項目（許可リスト） |
| :--- | :--- |
| `verify_start` | 設定の要約、実行の識別子 |
| `verify_phase` | 区間の名前、開始、終了 |
| `verify_progress` | 経過秒、区間ごとの累積の件数（10 秒おき） |
| `verify_error` | 事象の種類（`connect`、`http_5xx`、`timeout`）、件数（要求ごとには出さない。集計して出す） |
| `verify_cleanup` | 破棄の結果（アプリケーションの停止、データベースの削除の成否） |
| `verify_end` | 判定、終了コード |

要求ごとの詳細は出さない（標本の配列は要約の集計に使うだけ）。

## 成果物と保持

| 成果物 | 生成する場面 | 保持 | 内容 |
| :--- | :--- | :--- | :--- |
| 本試験の要約（`verify-summary.json`） | `main` へのプルリクエスト、夜間の定期実行、手動実行（10 分間の本試験）。成功でも失敗でも保存する | 30 日 | 上の要約。検査した branch とコミットを含む |
| 短い負荷試験の要約 | プルリクエストごとの CI | 7 日 | 同じ形。合否に使わない指標は `recordedOnly` |
| トレースと画面の画像 | 画面の試験が失敗したときだけ。`localhost` 以外を指した実行では保存しない | 7 日 | Playwright のトレースと画面の画像 |
| ジョブの要約 | すべての実行 | ワークフローの実行の保持に従う | `GITHUB_STEP_SUMMARY` に、閾値ごとの実測と合否の表を Markdown で出す。成果物を開かずに結果が読める |

## 失敗の検知

| 設計 | 内容 |
| :--- | :--- |
| 検知の手段 | ワークフローの実行が失敗として見え、GitHub の標準の通知で気づく。専用の警告の仕組みは作らない（U1 の Q4 の方針、U5 の Q4 の A と同じ） |
| 夜間の実行の失敗 | 不合格と無効のどちらでも、ワークフローが失敗する。要約の `verdict` と ジョブの要約で区別できる |
| 傾向の比較 | 要約が機械で読める形で 30 日残るため、実行をまたいだ比較（95 パーセンタイルの推移）は、成果物を取得して行える。比較の自動化は作らない |

## リリース前の確認票（NFR9.4）

| 設計 | 内容 |
| :--- | :--- |
| 様式 | リポジトリ内の文書（`docs/operation/` 配下。ファイル名は Code Generation で決める）。項目は NFR10.1 の主要な操作と同じ（ゲームの作成、参加、役割の割当て、開始、入力、週の確定）。確認ごとに、確認した日、確認した人、ブラウザの名前と版、合否と所見を 1 行の表に追記する |
| 対象 | 1 つ前の世代の Chromium、Firefox、WebKit、Edge の各ブラウザと、実機の Safari |
| 記録 | リリースのたびに、新しい節を足す。記録がない世代は「確かめた」と扱わない。リリースの手順書（`developing-release`）から、この確認票を参照する |
| 自動の検査 | 確認票の文書が存在し、必須の列の見出しを持つことを検査する単純な試験（Vitest）を置く。記録の内容の正しさは機械では確かめない |

## 実装で決まった差（Code Generation）

| 項目 | 実装 |
| :--- | :--- |
| `behind` の置き場 | `phases.behind`（区間をまたいだ累積の回数。区間ごとではない） |
| `errors` の欄 | `http5xx`、`unavailable`、`rateLimited`、`unexpected4xx`、`connect`、`timeout`、`reflectionMissing`。`rate_limited`（429）と想定外の 4xx は、閾値 `unexpectedResponses`（0 件）で合否に使う |
| `harness` の欄 | `eventLoopP99Ms`、`saturated`、`disconnectsSimulated`（切断の模擬の回数） |
| `verdict` | `{ result: pass \| fail \| invalid, reasons: [...] }`。無効の理由は `harness_saturated`、`target_not_allowed`、`run_failed`、`no_samples:<閾値名>` |
| ファイル | `verify-summary.json`（要約）と `verify-summary.md`（ジョブの要約の表）。どちらも Git の管理に入れない |
| 要約の許可リスト | `verification/shared/summary.ts` の `buildSummary` が、項目を 1 つずつ写す。入力に資格情報や接続文字列が混ざっても書けない（`tests/u6/unit/summary-contrast-language.spec.ts`） |

## 上流の資料

`observability-requirements.md`、`performance-requirements.md`、`security-requirements.md`、`reliability-requirements.md`
