## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-13T23:14:12Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | apps/beer-game3/verification/shared/target-guard.ts > isLocalDatabaseHost / databaseHostsOf（利用側: verification/load/lifecycle.ts の withAdminClient、verification/load/runner.ts の postgresVersion） | 接続先の検査は、ホストの書かれていない接続文字列（例 `postgres:///db`、`postgres://u:p@/db`）のホスト名を空文字として「ローカル」と判定して通す。しかし、管理用の接続は検査を行った同じプロセスで `new pg.Client({ connectionString })` を使うため、実行環境に `PGHOST` があるとそれが使われる。実際に `PGHOST=evil.example.com` で `new pg.Client({connectionString:'postgres:///db'}).host` は `evil.example.com` になった。つまり検査は「通った」のに、`create database bg3_verify_*`、`drop database ... with (force)`、古い DB の掃除が外部のサーバーへ向かい得る。子プロセスの環境は許可リスト方式で PG* を落としているが、検査と接続を行う親のプロセスはその対象外である。この経路は `tests/u6/features/safety.spec.ts` にもない。セキュリティ設計の「検査は最終の接続設定に対して行う」に反する。 | ホスト部が空の接続文字列は、ソケットのパスを `host=` で明示した場合だけ通し、それ以外は拒否する。あわせて、検査の前に実行環境の `PGHOST`、`PGHOSTADDR`、`PGSERVICE` が設定されていれば拒否する（または管理用の接続を作るときに `host` を明示する）。`PGHOST` が外部を指し、接続文字列にホストがない場合に拒否される試験を `safety.spec.ts` に足す。 | New |
| R-02 | Major | apps/beer-game3/verification/e2e/support/keyboard.ts > chooseOption（呼び出し元: verification/e2e/keyboard-flow.e2e.ts 工程 3） | 「キーボードだけで通せる」（AC5.5.1、NFR8.1）を確かめる試験が、`ArrowDown` で表示が 2 秒以内に変わらなければ、プラットフォームを問わず `select.selectOption({ label })`（プログラムによる選択）に切り替える。コメントは macOS だけの回避と説明するが、条件は OS で絞られていない。そのため、Linux の CI で役割の選択欄がキー操作で動かなくなる退行（キー入力の横取りなど）が起きても、試験は通る。code-summary.md も、Linux の CI では矢印キーだけで動く「想定」で「未確認」と記録している。キーボード操作の保証が、確認されていない前提の上にある。 | 切り替えを macOS の自動操作に限る（`process.platform === 'darwin'` など、条件を明示する）。Linux と Windows では切り替えを許さず、矢印キーで変わらなければ失敗させる。最初のプルリクエストの `e2e (chromium)`、`e2e (firefox)`、`e2e (webkit)`、`e2e (edge)` が、キーだけで通ることを確かめ、結果を code-summary.md か unit-test-instructions.md に記録する。 | New |
| R-03 | Minor | apps/beer-game3/verification/e2e/playwright.config.ts、.github/workflows/beer-game3.yml の e2e と a11y ジョブ（`npm run e2e` を直接実行） | セキュリティ設計は、アプリケーションに加えて Playwright の試験の実行器にも、許可リスト方式で選んだ環境だけを渡すとしている。実装は `buildChildEnv` をアプリケーションの起動にだけ使い、`playwright test` とそのワーカーは親の環境（`DATABASE_URL`、`PG*` を含む）をそのまま継承する。試験のコードはそれらを読まないが、設計の担保は実装されていない。 | 実行器にも許可リストの環境を渡す（`e2e` スクリプトを包む小さな起動部品を作る）。または、実行器は親の環境を継承することと、その理由、残るリスクを設計文書（security-design.md か cicd-pipeline.md の実装で決まった差）に記録して、設計を実装に合わせる。 | New |
| R-04 | Minor | apps/beer-game3/verification/e2e/a11y.e2e.ts > 'axe-core の規則に、コントラスト（color-contrast）が含まれる' と各状態の検査 | `color-contrast` が動いたことを、`passes`、`incomplete`、`violations` の和集合に含まれるかで確かめている。`incomplete`（axe が判定できなかった）だけでも通るため、コントラストが実際に判定された保証にならない。各状態の検査も `violations` だけを見て `incomplete` を無視する。code-summary.md の「`color-contrast` も実際に動いた」は、この試験からは言えない。 | 最初の状態で、`passes` に `color-contrast` があることを要求する。さらに、状態ごとに `incomplete` の `color-contrast` の対象を報告して、判定できなかった要素を人が確かめられるようにする。 | New |
| R-05 | Minor | apps/beer-game3/verification/shared/language.ts > findEnglishSentences | 英語の文の検出は、英字だけの語が 3 語以上続く場合に限る。`Loading data`、`Submit order` のような 1〜2 語の英語の表示文言や、`ERROR` のような大文字だけの語は検出されない。NFR11.1（日本語表示）の網羅が、検出の定義の穴に依存する。許可語（`week`、`role` など）の根拠も、設計文書にない。 | 検出の限界（何を見ないか）を unit-test-instructions.md か language.ts のコメントに明記する。可能なら、表示される文字列の一覧に対して、日本語の文字を 1 つも含まない 2 語以上の並びも検出する。許可語の一覧には、使われている場所と理由を添える。 | New |

### Validation Tool Results

実行は Node.js v24.11.0（既定のシェル）で行い、エンジンの制約（`engines: >=26.0.0`）による失敗は出なかった。

| Tool | Result | Interpretation |
|---|---|---|
| `npm --prefix apps/beer-game3 exec vitest run tests/u6/features tests/u6/unit` | PASS: Test Files 11 passed (11)、Tests 225 passed (225) | 合格。ただし、リポジトリのルートから `exec vitest` を呼ぶと `apps/beer-game3/vitest.config.ts` が使われない。この 2 ディレクトリには影響がなかった。 |
| `npm --prefix apps/beer-game3 run typecheck` | PASS（`tsc --noEmit` が出力なしで終了） | 合格。 |
| `npm --prefix apps/beer-game3 run lint` | PASS（`eslint .` が出力なしで終了） | 合格。 |
| `npm --prefix apps/beer-game3 run format:check` | PASS: All matched files use Prettier code style! | 合格。 |
| `npm --prefix apps/beer-game3 run test:u6`（DATABASE_URL は localhost:55432、設定ファイルが効く実行） | PASS: Test Files 14 passed (14)、Tests 241 passed (241) | code-summary.md の「14 ファイル、241 件が通過」と一致。 |
| `npm --prefix apps/beer-game3 exec vitest run tests/u6/integration`（ルートから。設定ファイルなし） | 1 failed、15 passed（`load-run-pg.spec.ts` の「データベースが残らない」） | 実行場所が原因の見かけの失敗。ルートからの `exec` では `fileParallelism: false` が効かず、並走する別ファイルの使い捨てデータベースが `before` に入った。`apps/beer-game3` を作業ディレクトリにすると全件が通る。指摘にはしない（調べた事実の記録）。 |
| `npm --prefix apps/beer-game3 run verify:prod-deps` | PASS: 本番の依存に、検証のための依存は含まれていません | NFR6.4 を満たす。 |
| 直接の確認 | `PGHOST=evil.example.com` で `new pg.Client({connectionString:'postgres:///db'}).host` が `evil.example.com` | 1 件目の指摘（Major）の根拠。 |
| 直接の確認 | `gh api repos/actions/{checkout,setup-node,upload-artifact}/tags` が、v7.0.1 の `3d3c42e5…`、v7.1.0 の `949feb24…`、v7.0.2 の `cf430e03…` を返す | ワークフローの固定の識別子は、コメントの版と一致。 |
| 直接の確認 | `src/` の最新の更新は 11-13 15:57。U6 の最初のファイルは 11-14 07:32 | U6 による `src/` の変更なし（確認項目 8）。 |
| 実行していない | `npm run e2e`（4 ブラウザ）、`verify:load:main`、GitHub Actions 上の動作 | 手元の macOS では Edge と WebKit のキー操作が動かせず、10 分超の本試験は時間の制約で見送り。code-summary.md も同じ範囲を未実行として開示している。ブロックの根拠にはしないが、最初のプルリクエストの CI の結果を必ず確かめる。 |

**確認項目の結果（指摘にならなかったもの）**

- traceability.json の 40 行の参照先は、すべて存在するファイルだった。
- 閾値（1 秒、2 秒、2 秒、500 ミリ秒、1 秒）、終了コード 0、1、2、5 秒と 10 秒の標本、最近順位法、予定時刻に基づく取り直し（飛ばさない）、読み取り専用の整合性検査（`begin read only`）、`retries: 0`、`waitForTimeout` と `setTimeout` の lint 禁止（試験つき）は、設計と実装が一致していた。
- `gate` の判定表（起動の種類、relevant、対象の branch、各ジョブの結果、`edited`、`false` 以外を真として扱うこと）と、ワークフローの条件、`needs`、行列の名前、保持日数（7 日と 30 日）、`permissions: contents: read`、シークレットなし、Node.js 26、`npm run build` の順序、並行実行の式は、`ci-gate.spec.ts` と `ci-workflow.spec.ts` を含めて整合していた。
- 依存は `devDependencies` にだけ、版を固定して追加されていた（`@playwright/test`、`@axe-core/playwright`、`axe-core`、`yaml`）。

### Summary

検証の部品（負荷試験、合否の判定、整合性検査、CI の判定と変更の検出）は、設計と一致し、試験も十分で、型検査、lint、整形、Vitest がすべて通る。主な懸念は 2 点で、ホストのない接続文字列が `PGHOST` で外部へ向き得る接続先検査の穴と、キーボード専用の試験が OS を問わずプログラムによる選択に切り替わる点である。いずれも局所の修正で直せるため、実装は設計文書だけで引き継げる状態とみなし READY とする（Major が 2 件のため、基準の上限ちょうど）。
