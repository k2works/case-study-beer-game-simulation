# CI/CD パイプライン - U6 u6-nfr-verification

U6 が作るのは、beer-game3 用の CI（検証のパイプライン）です。デプロイ（staging の自動反映、production の手動承認）は含めません。これらは、team の方針（beer-game3 専用の AWS 環境と、別に作るデプロイのワークフロー）に従い、後の Operation で作ります。既存の `beer-game-u1.yml`、`beer-game2*.yml` は別のアプリ用で、再利用も変更もしません。

出典: `nfr-design/` の 6 文書（特に `logical-components.md` の CI のジョブの設計と本試験の起動の設計）、`infrastructure-specification.md`、`monitoring-design.md`、`team.md`（`develop` 統合、`main` はリリース時の merge、Node.js 26、PostgreSQL 18、formatter・linter・type-check を CI で実行して失敗したら merge しない）、`apps/beer-game3/package.json`（`verify`、`typecheck`、`lint`、`format:check`、`test:coverage`）。

## 番号の付け方

`NFRn.m` は U6 の要件の番号である（U1〜U5 の同番号とは別の要件）。

## ワークフローの全体

| 項目 | 設計 |
| :--- | :--- |
| ファイル | `.github/workflows/beer-game3.yml`（1 ファイル） |
| 起動 | (1) `pull_request`（対象は `develop` と `main`。種別は `opened`、`synchronize`、`reopened` に **`edited`** を足す。PR の対象の branch を `develop` から `main` へ変えると `edited` が発火し、`main` 宛ての PR だけが要求する `load-main` を判定に反映できる）、(2) `push`（`develop` と `main`）、(3) `schedule`（夜間。ジョブは `develop` を明示して取得）、(4) `workflow_dispatch`（入力 `ref`、既定は `develop`） |
| 権限 | 最上位に `permissions: contents: read` だけ。ジョブごとの追加はしない。シークレットは使わない。環境（`environment:`）を指定しない。OIDC を使わない（NFR6.2） |
| 作業ディレクトリ | `apps/beer-game3`（`defaults.run.working-directory`） |
| 並行実行の制御 | 下の「並行実行の制御」の表のとおり。**夜間と手動の実行は、実行ごとに一意の集合に置き、取り消さない** |
| 変更の検出 | 最初のジョブ `changes` が、下の「変更の検出」の表のとおり、beer-game3 に関係する変更の有無（`relevant`）を出力する。ほかのジョブは `needs: changes` と `if: needs.changes.outputs.relevant == 'true'` で、関係がないときは飛ばす |
| 必須のチェック | **必須のチェックにするのは、集約のジョブ `gate` の 1 つだけ**（下の「集約のジョブ `gate`」）。行列（`e2e`）のジョブ名や、飛ばされたジョブの名前に、統合の保護を依存させない |
| 実行機 | `ubuntu-24.04`（`latest` を使わない） |
| 外部の actions | 完全なコミットの識別子で固定する（版をコメントに書く）。識別子は Code Generation で公式のリポジトリから確かめる。更新は人が確認して手作業で行う（回答 Q2 の A。Dependabot の設定は足さない） |
| 共通の準備 | `actions/checkout`（`changes` は差分の基準を取るため `fetch-depth: 0`。夜間と手動では `ref` を明示）、`actions/setup-node`（Node.js 26、npm のキャッシュ）、`npm ci` |
| 定義の版と取得する内容 | 夜間と手動は、`main` にあるワークフローの定義で動き、`develop`（または入力の `ref`）の内容を取得して検査する。したがって `develop` で変えたワークフローの定義は、`main` へ merge されるまで夜間と手動には効かない。`develop` の PR とリリース用 PR では、PR の側の定義で動く |

## 並行実行の制御

| 起動の種類 | 集合の名前（`concurrency.group`） | 取り消し（`cancel-in-progress`） |
| :--- | :--- | :--- |
| `pull_request` | `beer-game3-pr-` ＋ PR の番号 | 真（同じ PR の古い実行を取り消す） |
| `push` | `beer-game3-push-` ＋ `github.ref` | 真 |
| `schedule` | `beer-game3-nightly-` ＋ `github.run_id` | 偽。実行ごとに一意の集合のため、ほかの実行と待ち合わない |
| `workflow_dispatch` | `beer-game3-dispatch-` ＋ `github.run_id` | 偽。同上 |

集合の名前と取り消しの式は、ワークフローの定義の検査（Vitest）で、起動の種類ごとに上の表と一致することを確かめる。同じ集合に置くと、待機中の実行が新しい実行に置き換えられ、夜間と手動が黙って落ちるため、一意の集合にする。

## 変更の検出（ジョブ `changes`）

`relevant` は、次の表の規則で決める。**基準が取れない、または検出の手順が失敗した場合は、`relevant` を真に倒す**（検証を飛ばす方向には倒さない）。

| 起動の種類 | 比較の基準 | `relevant` |
| :--- | :--- | :--- |
| `pull_request` | `git diff --name-only origin/<基準の branch>...HEAD`（`fetch-depth: 0`。PR の先頭と、基準の branch との共通の祖先からの差分） | 対象のパス（下）に 1 件でも一致すれば真 |
| `push` | `github.event.before` から `HEAD` まで。`before` が全ゼロ（新しい branch）、または履歴にない（force push）場合は比較せず真 | 同上。比較できなければ真 |
| `schedule`、`workflow_dispatch` | 比較しない | 常に真（出力を固定する） |

**対象のパス**: `apps/beer-game3/**`、`.github/workflows/beer-game3.yml`、`docs/operation/` のうち名前に `beer-game3` を含む文書（リリース前の確認票と、リリースの手順書。`verify` の Vitest が読む）。`verify` の試験が読むパスを増やしたら、この一覧も同時に増やす（検査の Vitest が、読むパスが対象に含まれることを確かめる）。

## 集約のジョブ `gate`（必須のチェックの唯一の名前）

| 項目 | 設計 |
| :--- | :--- |
| 依存 | `needs: [changes, verify, e2e, a11y, load-smoke, load-main]` |
| 実行条件 | `if: always()`。依存が失敗や取り消しでも、必ず動いて結果を判定する |
| 判定 | **起動の種類ごとに書き分ける**（実装は `verification/ci/gate.ts`。組み合わせ表の試験が `tests/u6/unit/ci-gate.spec.ts`）。(1) 共通: `changes` が `success` でなければ失敗（失敗、取り消し、飛ばしのいずれも）。(2) **`schedule` と `workflow_dispatch`**: `relevant` に関わらず、`load-main` が `success` であることを必須にし、`verify`、`e2e`、`a11y`、`load-smoke` は `skipped` を許す（夜間と手動は `load-main` だけが動くため。走ったジョブが `failure`、`cancelled` なら失敗）。(3) **`pull_request` と `push`** で `relevant` が **`false`**（この文字列だけ）なら、`changes` 以外の 5 ジョブがすべて `skipped` であることを確かめて成功にする（1 つでも `skipped` でなければ失敗）。(4) **`pull_request` と `push`** で `relevant` が `false` 以外のすべての値（`true`、空、未設定、想定外の文字列）なら、**検証を要求する側に倒し**、`verify`、`e2e`、`a11y`、`load-smoke` がすべて `success` でなければ失敗にする（飛ばしも失敗）。`load-main` は、`main` を対象にした PR（`github.base_ref == 'main'`）では `success` を必須にし、それ以外（`develop` 宛ての PR と `push`）では `skipped` を許す（走った結果が `failure`、`cancelled` なら失敗）。(5) 知らない起動の種類は失敗にする |
| 理由 | 行列（`e2e`）は、ジョブ全体が飛ばされると展開前の名前 1 件だけが「飛ばし」として出るため、ブラウザごとの名前を必須にすると、beer-game3 以外の PR が待機のまま止まる。`changes` が失敗した場合も、依存するジョブがすべて飛ばされて統合できてしまう。`gate` 1 つに集約すれば、どちらの場合も、関係のない PR は通り、検証が動かないままの統合はできない |
| 必須のチェックの名前 | `develop` と `main` の保護の設定に、`gate` の 1 つだけを書く。ジョブ名は `gate` に固定し、ワークフローの名前も固定する（名前の変更は設定の見直しを伴うため、定義の検査で名前が変わっていないことを確かめる） |

## ジョブとゲート

| ジョブ | 内容（順に） | 起動 | 失敗の扱い | 所要の目標 |
| :--- | :--- | :--- | :--- | :--- |
| `changes` | 差分から beer-game3 の変更の有無（`relevant`）を判定 | すべての起動 | 失敗すると `gate` が失敗する | 1 分以内 |
| `verify` | PostgreSQL 18 のサービスコンテナを起動 → `npm ci` → `npm run verify`（型検査、linter、formatter の検査、カバレッジつきの Vitest。golden test、色の比、文言、CI 定義の検査、**依存の置き場の検査（下）** を含む。行のカバレッジ 80% を下回ったら失敗）→ **本番の依存の検査（下）** | `relevant` が真の PR と push | `gate` を通して必須。失敗すると統合しない（`NEVER merge a change while formatter, linter, or type-check CI checks are failing.`） | 10 分以内 |
| `e2e` | 行列で 4 つのブラウザ（Chromium、Firefox、WebKit、Edge）を並列に動かす。各ジョブ: `npm ci` → 該当のブラウザを導入 → 使い捨てのデータベースとアプリケーションを試験が起動 → キーボードだけの通し試験と主要な操作の試験。ジョブの名前は `e2e (<ブラウザ>)` に固定する | 同上 | `gate` を通して必須。`fail-fast: false` で、1 つが失敗しても他のブラウザの結果を出す。失敗時のみトレースと画像を保存（7 日。`localhost` のとき） | 20 分以内 |
| `a11y` | `npm ci` → Chromium を導入 → axe-core、状態の表示、日本語表示の画面の試験（画面 × 状態の一覧） | 同上 | `gate` を通して必須 | 10 分以内 |
| `load-smoke` | `npm ci` → PostgreSQL サービスコンテナ → 短い負荷試験（1 分、15 チーム、通常負荷。取り直しの標本は集計して合否に使い、最大想定の区間は含めない）→ 要約を保存（7 日、`if: always()`）→ ジョブの要約に表を出す。合否は標本が多い指標（取り直し、サーバーの異常、整合性）だけ。「無効」も失敗 | 同上 | `gate` を通して必須 | 5 分以内 |
| `load-main` | `npm ci` → PostgreSQL サービスコンテナ → Chromium を導入 → 本試験（通常負荷 10 分 → 最大想定 3 分、実ブラウザ 1 チーム）→ 要約を保存（30 日、`if: always()`）→ ジョブの要約に表を出す | (1) `main` を対象にした `pull_request`（`relevant` が真のとき。`changes` に依存する）、(2) `schedule`（夜間）、(3) `workflow_dispatch` | (1) では `gate` を通して必須（`main` への merge の前）。(2)(3) では失敗がワークフローの失敗として通知される。再実行で通っても合格にしない（`reliability-design.md`）。`main` を対象にした PR で `relevant` が偽のときは飛ばされ、`gate` が許す | 40 分以内 |
| `gate` | 上の「集約のジョブ `gate`」のとおり | すべての起動 | 必須のチェックそのもの | 1 分以内 |

**依存関係**: `verify`、`e2e`、`a11y`、`load-smoke`、`load-main` は互いに独立で並列に動く（待ち時間を短くする）。`gate` は最後に動く。

**所要の時間の見積もり**: `gate` が終わる時刻は、`changes`（1 分）＋最も遅い必須のジョブ（`e2e` の 20 分）＋実行機の待ち、`main` への PR では `changes` ＋ `load-main`（40 分）＋待ちである。SLO は、この合計に余裕を持たせて置く（`monitoring-design.md`）。

**サービスコンテナ**: PostgreSQL 18（版を固定）を `services` で起動し、健全性の確認を待つ。パスワードは使い捨ての固定値で、シークレットではない（NFR6.2）。使い捨てのデータベースの作成と破棄は試験のスクリプトが行う（`reliability-design.md`）。

### 依存の置き場の検査と本番の依存の検査（NFR6.4）

| 検査 | 動かす場所 | 内容 |
| :--- | :--- | :--- |
| 依存の置き場の検査 | `npm run verify` の中の Vitest | `package.json` を読み、Playwright、axe-core とその連携が `devDependencies` にだけあり（`dependencies` にない）、版が範囲指定（`^`、`~`、`*`）でなく固定であることを確かめる |
| 本番の依存の検査 | ジョブ `verify` の、`npm run verify` の後の別の手順 | `npm ls --omit=dev --all --json` の結果に、検証のための依存（`playwright`、`@playwright/*`、`axe-core`、`@axe-core/*`）が含まれないことを、小さなスクリプトで確かめる。`npm ci` を重ねて導入し直さない（導入し直すと同じジョブの試験が壊れるため、導入済みの木に対して `--omit=dev` の絞り込みを使って調べる） |
| 本番の成果物の作成（Operation） | 後の Operation のイメージの作成 | `npm ci --omit=dev` で作る。U6 では作らない |

## 環境の昇格と配備

U6 の CI はデプロイを含まない。したがって、環境の昇格（`dev → staging → production`）、段階的な配備の方式（blue-green、canary、rolling）、フィーチャーフラグは、このステージの範囲外である。

| 項目 | U6 での扱い | 後の担当 |
| :--- | :--- | :--- |
| staging への自動反映（`main` への merge で動く） | 作らない。CI の成功（`gate`）を前提にする | Operation（beer-game3 専用のデプロイのワークフロー） |
| production の手動承認 | 作らない | Operation |
| 段階的な配備の方式 | 対象外 | Operation |
| 成果物（アプリケーションのイメージ） | 作らない。本番の依存に検証の依存が含まれないことは、ジョブ `verify` の「本番の依存の検査」で確かめる（NFR6.4） | Operation |

## ロールバックと復旧

デプロイがないため、アプリケーションのロールバックは対象外。U6 が作るものの変更を戻す手順を、次のとおり定める。

| 対象 | 戻し方 |
| :--- | :--- |
| ワークフローの定義の変更 | コミットを `git revert` する。ワークフローは定義の変更だけで、外部の状態を持たない |
| 必須のチェックの設定（リポジトリの設定） | 設定した内容を手順書に記録し、設定から外す手順を同じ手順書に書く。設定は、Code Generation の完了後に、あなたの承認を得てから行う（回答 Q1 の A）。設定する名前は `gate` の 1 つ |
| 負荷試験が「無効」を続けて出す | 実行機の大きさを上げる、または設定値（チーム数、時間）を下げた短い試験で原因を切り分ける。閾値は緩めない（`performance-requirements.md` の NFR3.6） |
| 使い捨てのデータベースやプロセスの残り | 試験のスクリプトの掃除（1 時間より古い `bg3_verify_` のデータベース）。CI の実行機は破棄されるため、残りはない |
| CI が長期間使えなくなった場合（GitHub の障害など） | 手元で `npm run verify` を実行して確認する。ただし、統合の保護（必須のチェック）は代替できないため、復旧するまで統合を待つ |

## シークレットの管理

| 項目 | 設計 |
| :--- | :--- |
| 使うシークレット | なし。`GITHUB_TOKEN` の既定の権限（`contents: read`）だけ |
| 試験用のデータベースのパスワード | 使い捨てのサービスコンテナのための固定値。本番と staging の資格情報と関係がない |
| 外部への書き込み | しない（リリースの作成、タグ、コメント、パッケージの公開を含めない） |
| 変更時のルール | シークレットや書き込みの権限が必要な変更は、この設計の見直し（セキュリティの確認）を経て行う |
| 外部の actions | コミットの識別子で固定し、更新は人が確認して手作業で行う（回答 Q2 の A。Dependabot の設定は足さない） |

## 試験の自動化の統合

| 試験の種類 | 動かすジョブ | 失敗の扱い |
| :--- | :--- | :--- |
| 単位試験、統合試験、golden test | `verify` | `gate` を通して必須 |
| 画面の試験の通し・主要な操作 | `e2e`（4 ブラウザ） | 同上 |
| アクセシビリティ、状態の表示、日本語表示 | `a11y`（Chromium） | 同上 |
| 短い負荷試験 | `load-smoke` | 同上（標本が多い指標だけが合否） |
| 本試験 | `load-main` | `main` への PR では `gate` を通して必須。夜間と手動は通知 |
| ワークフローの定義の検査 | `verify`（Vitest） | 権限、シークレット、保持日数、取得の branch、`retries`、手動実行の入力、並行実行の制御の式、変更の検出の対象のパス、`gate` の依存と判定、ジョブとワークフローの名前を機械で確かめる |

不安定な試験は、隔離（skip）せず原因を直す（NFR2.3）。`retries` は 0 のまま。再実行で通ったことを合格にしない運用の測り方は `monitoring-design.md`。

## 最初のリリースの前と後

| 時期 | 動作 |
| :--- | :--- |
| 最初のリリースの merge の前 | `schedule` と `workflow_dispatch` は `main` に定義がないため動かない（GitHub の仕様）。`develop` の PR ごとの `gate` と、`develop` から `main` へのリリース用 PR の `load-main`（`gate` を通して必須）で検証する |
| 最初のリリースの merge の後 | `schedule`（夜間、`develop` を取得）と `workflow_dispatch` が動く。リリース用 PR の `load-main` も続ける |
| 定期実行の自動停止への対処 | 公開リポジトリでは、リポジトリの活動が長く（60 日）ないと、GitHub が定期実行を自動で無効にする。リリースの手順書の条件に、「夜間の定期実行が有効であること（`gh workflow list` の状態の確認）」を足し、無効になっていたら有効にし直して手動実行で確かめる |

リリースの手順書（`developing-release`）には、「リリース用 PR の `load-main` が成功していること」、「夜間の定期実行が有効であること」、「リリース前の確認票（NFR10.2）が記録されていること」を条件として書く。

## 実装で決まった差（Code Generation）

| 項目 | 設計からの差と理由 |
| :--- | :--- |
| actions の固定 | `actions/checkout` v7.0.1（`3d3c42e5aac5ba805825da76410c181273ba90b1`）、`actions/setup-node` v7.1.0（`949feb2413d6458794dcd2491c4babbbce0c15c1`）、`actions/upload-artifact` v7.0.2（`cf430e030ddbb5b0abf93d22962f4752f3646cd9`）。識別子は、公式のリポジトリの最新の公開版のタグから取得し、コミットの存在を確かめた。`actions/cache` は使わない（npm のキャッシュは `setup-node` の `cache: npm` で足りる。ブラウザの取得物のキャッシュは、ジョブの時間に収まるため見送った）。更新は人が確認して手作業で行う |
| 定義の検査 | `tests/u6/unit/ci-workflow.spec.ts` が、権限、シークレットの不使用、固定、保持日数、条件、並行実行の式、`types`（`edited` を含む）、`develop` の取得、`retries` を入れないこと、ジョブ名を機械で確かめる |
| 判定の部品 | `verification/ci/gate.ts`、`changes.ts`、`prod-deps.ts` は、依存も相対の import も持たず、Node.js が型を取り除いて直接実行する（`node verification/ci/gate.ts`）。`gate` と `changes` のジョブは `npm ci` をしない |
| 夜間と手動で動くジョブ | `changes` と `load-main` と `gate` だけ。`verify`、`e2e`、`a11y`、`load-smoke` は `pull_request` と `push` のときだけ動く（`gate` の判定が `skipped` を許すのはこのため） |
| 画面の試験のジョブ | `e2e` は `--project=<ブラウザ> keyboard-flow main-operations`、`a11y` は `--project=chromium a11y status-indication japanese`。ブラウザは `npx playwright install --with-deps <ブラウザ>`（Edge は `msedge`）。どちらも `npm run build` の後に動かす。試験が使い捨てのデータベースとアプリケーションを自分で起動する |
| ジョブの要約 | 負荷試験のスクリプトが `verify-summary.md`（表）と `verify-summary.json` を書き、ワークフローが `cat verify-summary.md >> "$GITHUB_STEP_SUMMARY"`（`if: always()`）で出す |
| 負荷試験のアプリケーションの起動方式 | 既定は `tsx`（ビルド不要）。`load-main` は `VERIFY_APP_MODE=dist`（ビルド済みの `dist/server/main.js`）で、本番に近い形を測る |
| PostgreSQL | サービスコンテナは `postgres:18.6`（版を固定）。パスワードは使い捨ての固定値 |
| 閾値の追加 | 要約の閾値に `unexpectedResponses`（429 と想定外の 4xx。有効な資格情報だけを使うため 0 件）を足し、合否に使う（`security-design.md` の「試験が `rate_limited` を受け取ったら失敗として数える」の実装） |

## 上流の資料

`nfr-design/logical-components.md`、`nfr-design/security-design.md`、`nfr-design/reliability-design.md`、`nfr-design/observability-design.md`、`infrastructure-specification.md`、`monitoring-design.md`
