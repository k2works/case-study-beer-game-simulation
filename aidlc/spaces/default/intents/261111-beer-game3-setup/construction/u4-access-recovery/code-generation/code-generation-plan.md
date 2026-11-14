# コード生成の計画 - U4 u4-access-recovery

## Summary

- Builds: 観察者の資格情報と観察画面、小売店の顧客需要、復帰用 token の有効期間と延長、参加の無効な試行の制限（PostgreSQL の窓）、接続元の特定、全入口の認可の構造と網羅試験、再起動からの復元の試験
- Touches: `apps/beer-game3/` の既存のコード（アクセス制御、API の入口と経路の表、保存、移行、設定、参加と取り直しの画面、ESLint、試験）。新しいアプリや新しい依存は足さない
- Tests: 振る舞いの例と単体・結合・画面の試験およそ 60 件。行カバレッジ 80% 以上（閾値は下げない）

出典: U4 の `functional-spec.md`、`rules.md`（BR15.1〜BR20.3）、`entities.md`、NFR の要件と設計（`nfr-requirements/`、`nfr-design/`）、`contract-summary.md`（C1、C3、C4）、U1〜U3 の実装（`apps/beer-game3/`）。

## 前提

- U1〜U3 のコードの上に足す。既存の試験は緑のまま保つ。
- 検証コマンドは承認済みのもの（`npm run verify`）を使う。PostgreSQL は `beer-game3-pg`（ポート 55432）。
- 既存の構成: `src/server`、`src/web`、`tests/u1`〜`tests/u3`。試験の scripts と `verify` は `tests/u1 tests/u2 tests/u3` を列挙しているため、`tests/u4` を足す。`AccessControl.authenticate` は `fac_` と `tok_` だけで、観察者（`obs_`）は未対応。`rate_limited`（429）は `errors.ts` に型だけある。ESLint に `no-restricted-imports` は無く、層の依存を見る構造の試験も無い。
- 設計の決定（NFR Design）: 窓の排他はアドバイザリロック（Q1 A）、古い行の削除は接続元ごとと起動時・10 分ごとの掃除（Q2 A）、lastUsedAt は応答のあとの条件付き更新（Q3 A）。接続元の設定名は `TRUSTED_PROXY_HOPS`。
- 設計のレビューで残った点は、実装で次のように決めて `code-summary.md` に記録する。
  - 参加の窓の検査は、本文の解析後（`preValidation`）に置く。参加コードが本文にあるため。形式不正の本文（コードの欠落）は 422 で、窓に数えない。
  - 資格情報の引き先は、`return_tokens` と `access_codes` の 2 つの索引を引いて種類を決める（性能の設計の記述を、この形に読み替える）。
  - 掃除は窓の削除を待たせない。窓は掃除の 1 文の間だけ短く待つことがあり、`lock_timeout` の範囲に収まる。
  - ログの許可リストの項目は 1 か所（入口の共通のエラー処理の定義）に定め、設計文書の二つの記述は、これを参照するものとして扱う。
- 順序の規則（プロジェクトの規則）: 保存の型とセッションの層を作り替える最初のスライド（Step 3〜4。`return_tokens.last_used_at` と `join_attempts`、`AccessControl` の主体の型）では、後続のスライドの振る舞いの試験も先に書いて、失敗を確かめてから実装する。順序を守れなかったときは、規則を壊すと試験が落ちることを個別に確かめて `code-summary.md` に記録する。
- 試験の方針は U1〜U3 と同じ（`unit-test-instructions.md`）。

## Testing Contract

```json
{
  "version": 1,
  "methodology": "bdd",
  "source": "team",
  "ordering": "Given/When/Then の振る舞い例と失敗する自動テストを実装前に定義し、最小実装で通した後に refactor します。",
  "scope": "feature",
  "test_strategy": "standard",
  "project_type": "brownfield",
  "applicable_notes": [
    {
      "layer": "org",
      "text": "We treat tests as a first-class deliverable in every Bolt. The specific\nmethodology (TDD, BDD, ATDD, or classic test-after) is affirmed at\npractices-discovery and recorded in `team.md` under this heading with explicit\n`Methodology` and `Ordering` fields; Code Generation resolves those fields\nindependently from coverage, tooling, and scope notes.\n\nWhen no posture has been affirmed, our default per scope is:\n- **Methodology**: test-after\n- **Ordering**: implement each applicable testable layer, then write and run\n  that layer's tests.\n- `mvp`, `enterprise`, `feature`, `infra`, `classic` add an 80% line-coverage\n  floor and CI execution before merge.\n- `bugfix`, `security-patch` add a targeted regression for the specific\n  bug/vulnerability and require the existing suite to remain green.\n- `express` uses the Minimal strategy: requirement-driven unit tests (one per\n  requirement, with a happy-path floor per component); existing tests remain\n  green.\n- `poc`, `refactor`, `workshop` add no extra new-test floor and require the\n  existing suite to remain green.\n\nThe active `Test Strategy` still applies in every scope and determines test\nvolume/types. Scope floors are additive; they never reduce or replace the\nselected strategy.\n\nBuild and Test verifies defined coverage floors and affirmed quality targets;\nthey may not be weakened to make a step pass.\n\nAffirm a stricter posture in `team.md` if the team commits to one."
    },
    {
      "layer": "team",
      "text": "- **Methodology**: bdd\n- **Methodology evidence**: 週次計算、週確定の冪等性、役割別認可、復元について、利用者から見える振る舞いを Given/When/Then で先に定義する方針を team が選択した。beer-game2 は受入条件との対応表を検査しており、BDD 運用の実績がある。\n- **Ordering**: Given/When/Then の振る舞い例と失敗する自動テストを実装前に定義し、最小実装で通した後に refactor します。\n- カバレッジは行 80% を基準（floor）とします。beer-game2 の lines・functions・statements 85、branches 75 のしきい値は引き継ぎません。\n- Unit Test と主要境界の Integration Test を CI で実行します。\n- 決定論的な週次計算には既知系列の golden test を用意し、冪等な週確定、役割別認可、復元を回帰テストで保護します。"
    },
    {
      "layer": "project",
      "text": "- 実装後のテスト追加や低レベルの TDD のみではなく、業務ルールを Given/When/Then で先に固定する BDD を採用した。週次計算、冪等性、役割別認可を実行可能な振る舞いとして追跡するためである。 (learned 2026-10-27) \n\n- 共通の土台（保存の型、セッションの層）を作り替えるスライドの後続は、振る舞いの試験より先に実装を書くと失敗を確かめられない。土台を変える最初のスライドで、後続の振る舞いの試験も先に書いて失敗を確かめてから実装する。順序を守れなかったときは、規則を壊すと試験が落ちることを個別に確かめて code-summary に記録する。 (learned 2026-11-12)"
    }
  ],
  "obligations": {
    "strategy": "standard",
    "strategy_volume": [
      "Five to eight tests per component.",
      "Unit tests plus integration tests for key boundaries.",
      "Add E2E, performance, or security tests when requirements demand them."
    ],
    "scope_floor": [
      "Meet an 80% line-coverage floor.",
      "Run the selected tests in CI before merge."
    ],
    "combination_rule": "Apply every selected-strategy obligation and every scope-floor obligation; neither replaces the other, and a targeted scope regression may add the narrowest necessary test type beyond the strategy default."
  },
  "plan_profile": {
    "methodology": "bdd",
    "runner_step": "Verify the existing test runner/configuration and record the exact unit-scoped command.",
    "runner_ready_before_first_test": true,
    "testable_layers": [
      "Data model / database behavior",
      "Repository / data access",
      "Business logic",
      "API / endpoint",
      "Frontend behavior"
    ],
    "steps": [
      "Project structure and production configuration skeleton.",
      "Verify the existing test runner/configuration and record the exact unit-scoped command.",
      "Behavior scenarios - define executable examples for the observable feature slice before implementation.",
      "Feature slice - implement the required data, repository, business, API, and frontend layers.",
      "Behavior scenarios - run the scenarios until they pass.",
      "Feature slice - refactor while the scenarios stay green.",
      "Environment/build configuration.",
      "Documentation and traceability."
    ]
  },
  "input_sha256": "sha256:5df8522b767bc3fef469d1ca778c766ee86edc757c1170cd962a655aa222f05e",
  "contract_sha256": "sha256:7ed7f6fa151431d2bddc00d40ba7409940bf767d5b5c142b673801267fbe4b51"
}
```

## 実装の手順

- [x] Step 1: 構成の準備。`tests/u4/{unit,integration,support}` を作り、`package.json` の test 系 scripts と `verify` に `tests/u4` を足す。設定の読み込み（zod）に `TRUSTED_PROXY_HOPS`（staging と production では必須）と、既定の token の有効期間・窓の数値（24 時間、10 回、60 秒、延長の間引き 1 分、掃除の周期 10 分）を足す。
- [x] Step 2: 試験の実行の確認。U4 だけの検証コマンドを確かめ、`unit-test-instructions.md` に記録する。既存の試験が緑であることを確かめる。
- [x] Step 3: 振る舞いの例（失敗する試験）を書く。土台の層: 移行後の表（`return_tokens.last_used_at`、`join_attempts`）、`AccessControl` の主体の型（observer）、`resolveParticipant` の同一の結果、`ObserverView` と小売店の顧客需要の投影の型。US2.1、US2.9、US3.2 の例（AC2.1.1〜AC2.1.3、AC2.9.1〜AC2.9.3、AC3.2.1〜AC3.2.4）。失敗を確かめる。
- [x] Step 4: 後続のスライドの振る舞いの例（失敗する試験）を先に書く。参加の窓（境界の 9・10・11 回目、有効なコードでも 429、60 秒後の解除、並行した試行、アプリケーション 2 つ、IPv6 の /64、射影アドレス、503）、接続元の特定（`TRUSTED_PROXY_HOPS`）、掃除、全入口の網羅試験と経路の表、構造の試験（入口から GameSession を import しない）、再起動の試験（US3.1: AC3.1.1〜AC3.1.3）、US5.4（AC5.4.1、AC5.4.2）。失敗を確かめる。
- [x] Step 5: データ層の実装。移行 `return_tokens.last_used_at`（既存の行は `issued_at` で埋める）と `join_attempts`（`id bigserial`、2 つの索引）、逆の移行。保存の層（PgStore と MemoryStore の両実装）に、token の引き、条件付き更新（最後の書き込みが 1 分以上前のときだけ）、窓の処理（アドバイザリロック、削除、件数、追加、11 件の保持）、掃除（`SKIP LOCKED`）を足す。
- [x] Step 6: 業務ロジックと認可の実装。`AccessControl` に観察者（`obs_`）の特定（2 つの表を引く）、操作の表（観察者は状態の取得だけ）、`isExpired`、`resolveParticipant`（不明・失効・期限切れを同じ結果に）、`ObserverView` と小売店の `customerDemand` の投影（`preparing` では空）を足す。入れ替えの新しい token は `last_used_at` を発行の時刻にする（U3 の入れ替えに反映）。
- [x] Step 7: API の層の実装。経路の表（`routeCatalog`）から経路を登録する形に直し、認可を `onRequest` で行う（存在しないゲームも別のゲームも 403）。参加の要求は `preValidation` で窓の検査を行い 429 を返す。接続元の正規化（`normalizeSource`）と `trustProxy`、固定の無効な資格情報の応答、拒否の分類（`invalid_token`、`invalid_code`、`rate_limited`）と許可リストのログ、拒否のカウンタ、応答のあとの `last_used_at` の更新、起動時と 10 分ごとの掃除。ESLint に入口から GameSession の import を禁止する `no-restricted-imports` を足す。
- [x] Step 8: 画面の実装。参加画面に「観察者として見る」の入口（コードを `localStorage` に保存、URL に出さない）、観察画面（`ObserverView`）、小売店の顧客需要の表示、取り直しに失敗している間の「接続が切れています。自動で再接続を試みます」の表示（1 秒周期のまま、入力欄を残す）、無効な資格情報を受けたときの保存の削除と文言の選択（参加者の token は BR17.3、観察者の入口は「観察者用コードが正しくありません」）。`data-testid` を足す。
- [x] Step 9: 振る舞いの例を通す。Step 3〜4 の試験が緑になるまで実行する。規則を壊すと試験が落ちること（Step 3〜4 の順序を守れなかった項目）を個別に確かめる。
- [x] Step 10: リファクタリング。試験が緑のまま、重複を取り除く（資格情報の引き、投影の型、窓の SQL）。
- [x] Step 11: 環境とビルドの設定。`.env` の例と README の設定の表に `TRUSTED_PROXY_HOPS` と数値の設定を記す。契約（`contract-summary.md` の C1、C3、C4）の該当記述を、実装と同じ変更の中で確かめる。
- [ ] Step 12: ドキュメントと追跡。`code-summary.md`、`source-manifest.json`、`traceability.json`（AC、NFRx.y、BRx.y）を書く。

## 追跡

| ストーリー | 受入条件 | 規則 | NFR | 手順 |
| :--- | :--- | :--- | :--- | :--- |
| US2.1 小売店だけが当週までの需要を見る | AC2.1.1〜AC2.1.3 | BR16.1、BR16.2 | NFR6.3 | Step 3、6 |
| US2.9 観察者が入力できずに進行を見る | AC2.9.1〜AC2.9.3 | BR15.1〜BR15.4 | NFR6.1、NFR6.2、NFR6.10、NFR8.1 | Step 3、6、7、8 |
| US3.1 中断したゲームを確定済みの週から復元する | AC3.1.1〜AC3.1.3 | BR20.1、BR20.2 | NFR1.1、NFR5.1 | Step 4、9 |
| US3.2 参加者が切断後に同じ役割へ戻る | AC3.2.1〜AC3.2.4 | BR17.1〜BR17.6、BR20.3 | NFR2.1、NFR3.3、NFR3.5、NFR5.2〜NFR5.4、NFR6.4 | Step 3、5、6、8 |
| US5.4 操作権限をサーバー側で検証する | AC5.4.1、AC5.4.2 | BR18.1〜BR18.3、BR19.1〜BR19.3 | NFR2.2、NFR2.3、NFR4.2〜NFR4.4、NFR6.5〜NFR6.9、NFR7.1、NFR9.1〜NFR9.5 | Step 4、5、7 |

## 試験の量

- 単体: AccessControl（観察者、操作の表、`isExpired`、`resolveParticipant`）、投影の型、`normalizeSource`、設定の検査: 約 25 件
- 結合（PostgreSQL）: 窓（境界、並行、2 アプリケーション、503）、条件付き更新、掃除、移行、再起動、経路の表の網羅: 約 25 件
- 構造: 入口から GameSession の import の禁止、経路の表と登録の差: 約 3 件
- 画面: 観察者の入口、観察画面、顧客需要の表示、切断中の表示、無効な資格情報の文言: 約 8 件
