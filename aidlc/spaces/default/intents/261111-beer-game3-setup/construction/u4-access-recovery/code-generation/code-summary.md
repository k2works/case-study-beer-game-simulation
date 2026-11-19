# コードの要約 - U4 u4-access-recovery

U4（復帰と権限）を `apps/beer-game3/` に実装しました。計画の Step 1〜11 を完了し、`npm --prefix apps/beer-game3 run verify` は全緑です。

## 検証の結果

| 項目 | 結果 |
| :--- | :--- |
| typecheck / eslint / prettier | エラーなし |
| 試験 | 47 ファイル 504 件が全件成功（既存 390 件 + U4 の新規 114 件） |
| カバレッジ | 行 93.8%（閾値 80%）、文 94%、分岐 85.83%、関数 96.46%。閾値は下げていない |

新規 114 件の内訳: 単体・構造 33（`tests/u4/unit/`）、振る舞い 50（`tests/u4/features/`）、結合 17（実 PostgreSQL、`tests/u4/integration/`）、画面 14（`tests/u4/web/`）。計画の目安（約 60 件）を超えた。書いたが実行していない試験は無い。E2E（Playwright）は実行していない（この Unit の計画に含めていない）。

## 作成・変更したファイル

`source-manifest.json` に全件を記録した。主なもの:

- 移行: `migrations/1763100000000_u4-access-recovery.sql`（`return_tokens.last_used_at`、`join_attempts`、逆の移行）
- アクセス制御: `access/access-control.ts`（観察者、操作の表、`isExpired`、`resolveParticipant`、`attemptJoin`、`touch`）、`access/policy.ts`、`access/source.ts`（接続元の正規化）、`access/join-sweeper.ts`（掃除）、`access/session-gateway.ts`
- 入口: `http/app.ts`（`onRequest` で認可、`preValidation` で窓、許可リストのログ、カウンタ、応答後の延長）、`http/routes.ts`（経路の表）
- 保存: `session/{store,memory-store,pg-store,game-session,projection}.ts`
- 画面: `ObserverScreen.tsx`、`JoinScreen.tsx`、`GameScreen.tsx`、`PlayScreen.tsx`、`App.tsx`、`api.ts`、`storage.ts`
- 設定: `config.ts`、`.env.example`、`README.md`、`eslint.config.js`、`package.json`

## 設計レビューで残った点の決定

1. 参加の窓の検査は、参加の経路の `preValidation` で行う。`joinCode` が文字列でない、または空の本文は窓に数えず、通常の 422 になる。
2. 資格情報の種類は、ヘッダの形ではなく照合の結果で決める。`return_tokens` と `access_codes`（進行役用・観察者用）の索引を並列に引く。参加コードは資格情報にならない。
3. 掃除は `FOR UPDATE SKIP LOCKED` で窓のロックを待たない。窓側は掃除の 1 文の間だけ待つことがあり、`lock_timeout`（3 秒）に収まる。
4. ログの許可リストは `http/app.ts` の `LOG_FIELDS` の 1 か所。拒否の種類は `invalid_token`、`invalid_code`、`rate_limited`。
5. 窓の鍵は、生のアドレスを保存せず、`keyedDigest(normalizeSource(ip))`（鍵付きの要約）にした。ログの `src` も同じ値である。

## 設計との差分・判断（レビューの対象）

- 入口が GameSession を import しない形にするため、GameSession の構築を `access/session-gateway.ts` に移した。`SessionGateway` も各操作で `authorize` を再度呼ぶ。
- 観察者の投影の項目名は `entities.md` に従った（`teamWeeklyCost`、`teamCumulativeCost`、`teamInventory`、`teamBacklog`、`inputsDone`）。`security-design.md` の別名（`weekCostTotal` など）とは異なる。契約 C1 の必須項目（`viewerKind`、`gameId`、`name`、`weekCount`、`setupKind`、`version`）も含める。役割別の値、表示名、コードは含めない。
- 無効な資格情報の拒否は、資格情報なし、無効、不明・失効・期限切れ、権限なし、別のゲーム、存在しないゲームのすべてを同じ 403 の本文にした（既存の「資格情報なしと無効が同じ形」の試験との整合）。
- `trustProxy` には、段数を意味する関数 `(addr, hop) => hop < hops` を渡す（Fastify の型が数値を受け付けないため。意味は段数指定と同じ）。
- 追加した環境変数: `APP_ENV`（既定 development）、`TRUSTED_PROXY_HOPS`（staging と production で必須）、`RETURN_TOKEN_TTL_MINUTES`、`TOKEN_TOUCH_INTERVAL_SECONDS`、`JOIN_WINDOW_SECONDS`、`JOIN_WINDOW_MAX_ATTEMPTS`、`JOIN_SWEEP_INTERVAL_MINUTES`。
- 試験用の口: `app.whenIdle()`、`app.rejectionCounts()`、`app.registeredRoutes()`、`store.countJoinAttempts()`。
- 画面: 観察者用コードは `localStorage` の `beerGame3.observer` に保存する。
- 既存の試験の更新: `AccessControl` が `clock` を必須にしたため `tests/u1/support/world.ts` と `code-collision.spec.ts` を更新、`tests/u1/support/pg.ts` は `join_attempts` も空にする、`tests/u2`・`tests/u3` の PostgreSQL の試験は移行を戻す段数を増やした、`tests/u1/web/game-screens.spec.tsx` は切断中の文言を BR20.3 に合わせた。
- `unit-test-instructions.md` の U4 だけの試験のコマンドは、`exec -- vitest` がリポジトリ直下を root にして他のアプリの試験まで拾い失敗したため、`npm run test:u4` に直した。

## 計画の順序の記録

Step 3〜4 の振る舞いの試験をすべて、実装の前に書いた。実装の前に `test:u4` を実行し、56 件の失敗とファイル単位の import 失敗を確かめた（赤の確認）。Step 1 の設定、`policy.ts`、`rateLimitedError` は、試験より前に入れた（振る舞いの試験は赤のまま実装前）。順序を守れたため、「規則を壊すと試験が落ちる」ことの個別確認は記録対象にしない。ただし、観察者の許可操作に `pauseGame` を足して試験が落ちることを確かめる実行は、自動分類器に拒否され、実施していない。この確認は、試験が観察者の操作の表を検査していること（`OBSERVER_ACTIONS` が `['viewState']`）を別の試験が見ている点で代替しているが、未実施である。

## 未実施・残る点

- 受入条件の ID は、ストーリーに実在する 12 件（AC2.1.1〜2、AC2.9.1〜2、AC3.1.1〜2、AC3.2.1〜4、AC5.4.1〜2）で追跡した。計画の追跡の表にある AC2.1.3、AC2.9.3、AC3.1.3 はストーリーに存在しないため、対象にしていない。

- 設計のレビューで指摘された、要件側の記述の揺れ（`security-requirements.md` の NFR7.1 の（b）と、設計の掃除）は、設計が意図的に置き換えた形のまま。要件の文書は直していない。
- PostgreSQL のコンテナ `beer-game3-pg` が停止していたため、`docker start beer-game3-pg` で起動した。
- 契約（`contract-summary.md` の C1、C3、C4）の記述は、実装と照合して差分が無いため変更していない。
