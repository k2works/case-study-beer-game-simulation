# 試験の手順 - U1 u1-walking-skeleton

U1 の試験の実行方法です。すべてのコマンドは、この Unit の試験だけを対象にします（`apps/beer-game3/` の `tests/u1/` を指定）。

## 試験の構成

- 振る舞いの試験（Given/When/Then）: `apps/beer-game3/tests/u1/features/*.spec.ts`。メモリ上のリポジトリを使い、DB を使わない。
- 単体の試験: `apps/beer-game3/tests/u1/unit/*.spec.ts`
- 結合の試験: `apps/beer-game3/tests/u1/integration/*.spec.ts`。実際の PostgreSQL 18 に接続する。
- 画面の試験: `apps/beer-game3/tests/u1/web/*.spec.tsx`

## 事前準備

- Node.js 26、PostgreSQL 18。
- 環境変数 `DATABASE_URL`（結合の試験用の空のデータベース）、`CODE_ENC_KEY`、`CODE_HMAC_KEY`（試験用の固定の鍵）。`.env.example` に例を置く。
- 依存のインストール: `npm install`（`apps/beer-game3/` で実行）。

## 実行するコマンド

| 目的 | コマンド |
| :--- | :--- |
| 振る舞いと単体（DB なし） | `npm --prefix apps/beer-game3 exec -- vitest run tests/u1/features tests/u1/unit` |
| 結合（要 PostgreSQL） | `npm --prefix apps/beer-game3 exec -- vitest run tests/u1/integration` |
| 画面 | `npm --prefix apps/beer-game3 exec -- vitest run tests/u1/web` |
| カバレッジ（U1 の全体） | `npm --prefix apps/beer-game3 exec -- vitest run tests/u1 --coverage` |
| 型検査 | `npm --prefix apps/beer-game3 exec -- tsc --noEmit` |
| lint と書式 | `npm --prefix apps/beer-game3 exec -- eslint .` と `npm --prefix apps/beer-game3 exec -- prettier --check .` |

最初のコマンド（振る舞いと単体）は、最初の試験を書く前に実行できる状態にする（Step 2）。

## カバレッジ

- 行カバレッジの下限は 80%。設定は `vitest.config.ts` の `coverage.thresholds.lines`。下げない。
- 閾値を満たさないときは、試験を足す。設定を緩めない。

## 振る舞いの試験の方針

- 受入条件（AC）ごとに 1 つ以上の `describe`/`it` を作り、名前に AC の ID を含める（例: `AC1.5.3`）。Given/When/Then をコメントでなく試験の構造で表す。
- 既知系列: AC1.5.3、AC1.5.4、AC1.5.9 の数値、AC1.5.5・AC1.5.6 の遅延（第 t 週の出荷が第 t+2 週の入荷）。
- 失敗を先に確かめる: 実装前に実行して、期待どおりに失敗することを確認する。

## モックと固定

- 時計（Clock）と乱数（RandomSource）は注入し、試験では固定の値に差し替える。
- 週の計算（SimulationEngine）は、モックせず、そのまま呼ぶ。
- 結合の試験では、PostgreSQL をモックしない。各試験の前にテーブルを空にする。

## 試験データ

- 既定の需要系列（週 1〜4 は 4、週 5 以降は 8）を使う。
- 4 役割の参加者は、表示名「工場」「一次卸」「二次卸」「小売店」の 4 人。
- 鍵は試験用の固定値で、本番の鍵と共有しない。

## 最新化（Code Generation 後の実測と補足）

### 準備の具体例

- PostgreSQL 18 は Docker で用意できる: `docker run -d --name beer-game3-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:18`、続けて `docker exec beer-game3-pg psql -U postgres -c "create database beer_game3_test"`。
- 結合の試験の接続先: `DATABASE_URL=postgres://postgres:postgres@localhost:55432/beer_game3_test`。移行は試験の初回に自動で適用し、各試験の前に全部の表を空にする（`truncate games cascade`）。`DATABASE_URL` が無い結合の試験は、飛ばさずに失敗する。
- 鍵（`CODE_ENC_KEY`、`CODE_HMAC_KEY`）は `vitest.config.ts` に試験用の固定値を持つ。環境変数で上書きできる。
- 画面の試験は jsdom で動き、`tests/u1/web/setup.ts`（jest-dom の拡張）が自動で読み込まれる。

### 実際のコマンド（`apps/beer-game3/` で実行）

| 目的 | コマンド |
| :--- | :--- |
| 振る舞いと単体（DB なし） | `npm run test:unit`（`vitest run tests/u1/features tests/u1/unit`） |
| 結合（要 PostgreSQL） | `DATABASE_URL=… npm run test:integration` |
| 画面 | `npm run test:web` |
| カバレッジ（U1 の全体。行 80% の閾値つき） | `DATABASE_URL=… npm run test:coverage` |
| まとめて検証 | `DATABASE_URL=… npm run verify`（型検査、lint、書式、カバレッジ） |

### 試験の構成（実際のファイル）

| 場所 | 内容 | 件数 |
| :--- | :--- | :--- |
| `features/week-calculation.spec.ts` | AC1.5.3〜AC1.5.7、AC1.5.9（週の計算の既知系列） | 13 |
| `features/game-creation.spec.ts` | AC1.1.1〜AC1.1.5、コードの性質 | 20 |
| `features/joining-and-start.spec.ts` | AC1.2.1〜AC1.2.4、AC1.3.1〜AC1.3.3 | 20 |
| `features/decisions-and-views.spec.ts` | AC1.4.1〜AC1.4.4、再送と判定の順 | 25 |
| `features/week-confirmation.spec.ts` | AC1.5.1、AC1.5.2、AC1.5.8、原子性・直列処理 | 20 |
| `features/api-flow.spec.ts` | 入口（HTTP）の薄い一通りと拒否 | 10 |
| `unit/` | 鍵とコード、HTTP の安全とログ、設定と画面の配信、コードの重なり | 30 |
| `integration/pg-store.spec.ts`、`integration/thin-slice.spec.ts` | 実際の PostgreSQL（原子性、行の占有、制約、復元、薄い一通り、並行） | 21 |
| `web/` | 画面（S0〜S3、進行役の確定）、API クライアント、資格情報の保存 | 47 |

### 実測（2026-11-12）

206 件すべて成功。行カバレッジ 94.05%、分岐 84.46%、関数 96.04%、文 94.02%。詳細と、実行しなかった試験は `code-summary.md` を参照。
