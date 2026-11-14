# 試験の手順 - U6 u6-nfr-verification

U6 の試験は、新しい業務機能ではなく、検証の仕組みそのもの（負荷試験のスクリプト、実ブラウザの測定、画面の試験の規約、CI の定義）を確かめます。試験の置き場は `apps/beer-game3/tests/u6/` と `apps/beer-game3/verification/e2e/` です。すべてのコマンドは、この Unit の試験だけに絞ってあります（全体のコマンドは使いません）。

## 前提

- Node.js 26（`.nvmrc`）。PostgreSQL 18 が `localhost:55432` で動いていること（既存の Unit と同じ試験用の接続）。
- 結合の試験の接続先: `DATABASE_URL=postgres://postgres:postgres@localhost:55432/beer_game3_test`（検証コマンドと同じ値）。
- 実ブラウザの試験は、先に `npm --prefix apps/beer-game3 run build`（画面の配信用）と、`npx playwright install chromium`（手元。CI は各ジョブで必要なブラウザを導入）が済んでいること。
- ポート 3000 と 5173 の開発サーバーは止めず、触れない。試験が起動するアプリケーションは、空きポートを使う。

## 実行コマンド（この Unit だけ）

| 目的 | コマンド | 備考 |
| :--- | :--- | :--- |
| 単位・振る舞いの試験（データベース不要の部分） | `npm --prefix apps/beer-game3 exec vitest run tests/u6/features tests/u6/unit` | Step 2 の最初のコマンド。空の実行はここで通る |
| 結合の試験（PostgreSQL） | `DATABASE_URL=postgres://postgres:postgres@localhost:55432/beer_game3_test npm --prefix apps/beer-game3 exec vitest run tests/u6/integration` | 使い捨てのデータベースを作って破棄する |
| U6 の Vitest の全部 | `DATABASE_URL=postgres://postgres:postgres@localhost:55432/beer_game3_test npm --prefix apps/beer-game3 exec vitest run tests/u6` | 上の 2 つを合わせたもの |
| 画面の試験（Chromium のみ） | `npm --prefix apps/beer-game3 run e2e -- --project=chromium` | 画面の通し、axe-core、状態の表示、日本語表示 |
| 画面の試験（4 ブラウザ） | `npm --prefix apps/beer-game3 run e2e` | 手元に Firefox、WebKit、Edge がなければ CI（`e2e` ジョブ）で確かめる |
| 短い負荷試験（1 分、15 チーム） | `DATABASE_URL=... npm --prefix apps/beer-game3 run verify:load:smoke` | 使い捨てのデータベースとアプリケーションを自分で起動する |
| 実ブラウザの反映の測定の確認 | `npm --prefix apps/beer-game3 run verify:render` | Chromium が導入されている環境で動かす |
| 本試験（通常負荷 10 分 + 最大想定 3 分） | `npm --prefix apps/beer-game3 run verify:load:main` | 約 14 分。手元で動かしてよいが、合否の証拠にはしない（CI の `load-main` が証拠） |
| 全体の検証（既存の検証コマンド） | `DATABASE_URL=postgres://postgres:postgres@localhost:55432/beer_game3_test npm --prefix apps/beer-game3 run verify` | 型検査、lint、整形の検査、カバレッジつきの全試験（U1〜U6） |

## 試験の構成（Standard: 部品ごとに 5〜8 件）

| 部品 | 種類 | 試験の場所 | 内容 |
| :--- | :--- | :--- | :--- |
| 接続先の検査、秘匿の型 | 単位・振る舞い | `tests/u6/features/safety.spec.ts`、`tests/u6/unit/` | `localhost` の判定、`host=` の上書き、外部の接続情報を継承しない環境、許可時の成果物の無効化、秘匿の型 |
| 種付きの乱数、統計、設定、閾値、要約 | 単位 | `tests/u6/unit/` | 要求の列の再現、最近順位法の百分位、立ち上げ期間の除外、上限値の標本（5 秒、10 秒）、設定の既定、短い試験と本試験の判定の違い、「無効」、要約の必須の欄 |
| 色の比、文言の検査 | 単位 | `tests/u6/unit/` | 既知の色の比、グラフの系列の色の 3:1、`messages.ts` に英語の文が混じらないこと |
| 整合性の検査、使い捨ての起動と破棄 | 結合（PostgreSQL） | `tests/u6/integration/` | 週の欠け、二重、値の欠落の検知、読み取り専用（`25006`）、失敗を注入した後に残りがない |
| 負荷試験の実行 | 結合（PostgreSQL とアプリケーション） | `tests/u6/integration/` | 2 チーム数秒の実行が合格で終わり要約が揃う、同じ種で要求の列が一致、測定器の飽和で「無効」（終了コード 2） |
| 実ブラウザの反映の測定 | 単位（疑似のページ）と結合（Chromium） | `tests/u6/unit/`、`verify:render` | 始点より前の観察は 0 に丸めて件数を記録、未反映は 10 秒の標本。実ブラウザでは 5 画面が新しい週を表示するまでを測る |
| CI の定義、`gate`、変更の検出、依存の置き場 | 単位 | `tests/u6/unit/ci-*.spec.ts` | 権限、シークレット、保持日数、`if` の条件、並行実行の式、`types: edited`、対象のパス、`gate` の組み合わせ表（起動の種類 × `relevant` × 対象の branch × 各ジョブの結果）、固定した actions、`devDependencies` への配置と版の固定 |
| リリース前の確認票 | 単位 | `tests/u6/unit/checklist.spec.ts` | 文書の存在と必須の列の見出し |
| 画面の通し、主要な操作、axe-core、状態の表示、日本語表示 | 画面（Playwright） | `verification/e2e/*.e2e.ts` | キーボードだけの 6 工程、4 ブラウザの主要な操作、画面 × 状態の axe-core、状態の文字・名前、日本語表示 |

## カバレッジ

- 既存の閾値（行 80%）は変えない。対象は `src/**` のまま。`verification/` は計測の対象に含めない（新しい検証のコードで `src/` の割合が動かないようにするため）。
- `verification/` の品質は、型検査（`tsconfig` の対象に追加）、lint、整形の検査と、上の試験で保つ。

## モックと補助

- アプリケーションと PostgreSQL は、結合の試験では本物を使う（モックしない）。
- 実ブラウザの測定の単位試験では、`page` の観察の仕組みだけを疑似に差し替える。
- 画面の試験の状態（エラー、一時停止、終了、結果、出力の注意書き）は、公開の API で作る補助（`verification/e2e/support/`）で用意する。内部の関数や DB への直接の書き込みで作らない。
- 時刻に依存する試験は、`page.clock` またはアプリケーションの時計の注入の口で時刻を進める。固定の待ち（`waitForTimeout`）は使わない（ESLint で禁止）。

## 試験データ

- 表示名、参加コード、進行役用コード、復帰用 token は、試験の中で生成した架空の値にする。表示名は種付きの規則で作る（例: 「試験チーム 03 発注役」）。実在の個人や組織を指す語を使わない。
- 資格情報は、試験の出力（ログ、要約）に書かない。
- 使い捨てのデータベースの名前は `bg3_verify_<実行の識別子>`。試験の終了時に必ず削除する。

## 実行しない試験と理由（計画の時点）

- Firefox、WebKit、Edge の画面の試験: 手元に導入されていない場合は CI の `e2e` ジョブで確かめる。
- 10 分間の本試験（`load-main`）の合否: CI のリリース用プルリクエストで確かめる。手元の実行は動作の確認で、合否の証拠にしない。
- CI 上の動作（`gate`、並行実行、保持日数）: ワークフローの定義の検査（Vitest）で定義を確かめ、実際の動作は最初のプルリクエストの実行で確かめる。

## 最終の確認（Code Generation の完了時）

| コマンド | 結果 |
| :--- | :--- |
| `npm --prefix apps/beer-game3 exec vitest run tests/u6`（`DATABASE_URL` つき） | 14 ファイル、241 件が合格（unit、features、integration） |
| `npm --prefix apps/beer-game3 run e2e -- --project=chromium` | 65 件が合格（keyboard-flow、main-operations、a11y、status-indication、japanese） |
| `npm --prefix apps/beer-game3 run e2e -- --project=firefox --project=webkit main-operations` | 合格。`keyboard-flow` は Firefox が合格（macOS で動かした場合、選択欄の確定だけ `selectOption` で代える） |
| `npm --prefix apps/beer-game3 run verify:load:smoke` | 合格（終了コード 0）。15 チーム、1 分、取り直しの標本 約 4500 件 |
| `npm --prefix apps/beer-game3 run verify:render` | 合格。実ブラウザ 5 画面の反映の標本 20 件 |
| `DATABASE_URL=... npm --prefix apps/beer-game3 run verify` | 合格（84 ファイル、959 件）。行のカバレッジ 94.5%（閾値 80% は変えていない） |

- **Linux の CI と macOS の手元の違い**: macOS では、選択欄（`select`）の矢印キーが OS 標準の一覧を開き、自動操作のキー入力が届かない。このため `chooseOption` は、矢印キーで値が変わらないときだけ `selectOption` に代える（Linux の CI では矢印キーだけで通る想定。CI で確かめる）。macOS の WebKit は、Tab キーでボタンにフォーカスが届かない（OS の既定の設定）ため、手元では `keyboard-flow` の WebKit を確かめられない。Linux の CI の `e2e (webkit)` で確かめる。
- **実行していない**: Edge（macOS に `msedge` なし）、WebKit の `keyboard-flow`（上の理由）、10 分間の本試験、CI 上の動作。
