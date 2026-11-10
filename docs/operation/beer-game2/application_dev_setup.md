---
type: Reference
title: "アプリケーション開発環境セットアップ手順書 - beer-game2"
description: "beer-game2 をローカルで開発・実行するための手順。Node 26、PostgreSQL 18、マイグレーション、テスト、E2E。Bolt 1 時点の初版。"
tags: [operation, setup]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-10T01:30:00Z }
---

# アプリケーション開発環境セットアップ手順書（beer-game2）

Bolt 1（2026-11-10）時点の初版です。ステージング・本番の手順は B2 以降で追加します。

## 前提

| 項目    | 版                                  | 備考                                              |
| :------ | :---------------------------------- | :------------------------------------------------ |
| Node.js | 26（`apps/beer-game2/.nvmrc`）      | `nvm install 26 && nvm use`                       |
| Docker  | 任意の最近の版                      | PostgreSQL 18 の実行に使う                        |
| ポート  | 5433（DB）、3000（API）、5173（UI） | `apps/beer-game`（v1）と衝突しないよう DB は 5433 |

## 手順

```bash
cd apps/beer-game2
nvm use
npm ci
npm run db:up          # PostgreSQL 18 を起動
export DATABASE_URL=postgres://beer_game2:local-only@localhost:5433/beer_game2
npm run migrate        # スキーマを適用
npm start              # API: http://localhost:3000
npm run dev:client     # UI: http://localhost:5173（別の端末）
```

開発では、鍵などの環境変数は既定値で起動します。**`NODE_ENV=production` では、次が無いと起動に失敗します**。

| 変数                     | 内容                                                |
| :----------------------- | :-------------------------------------------------- |
| `DATABASE_URL`           | 接続先                                              |
| `ALLOWED_ORIGIN`         | 変更系の要求を受け付ける Origin                     |
| `CREDENTIAL_HMAC_KEY`    | 資格のダイジェストの鍵（16 進 64 文字 = 32 バイト） |
| `CREDENTIAL_KEY_VERSION` | 鍵の版（既定 `v1`）                                 |
| `IDEMPOTENCY_KEY`        | 冪等記録の応答を暗号化する鍵（16 進 64 文字）       |

## ローカルで動かして確認する

```bash
npm run dev      # DB 起動 → マイグレーション → API と UI を起動（UI: http://localhost:5173）
npm run smoke    # 別の端末で。作成 → 参加 → 割り当て → 開始 → 入力 → 確定 を API で通す
```

`smoke` は、`/health`・`/ready`、顧客需要が小売店だけに開示されること、確定後に 2 週目へ進み役割別の結果が残ることを確認します。接続先は `API_URL`、`ORIGIN` で変えられます。

## 1 人で 1 ゲーム遊ぶ（ローカル）

進行役の資格と参加者の資格は別の Cookie なので、**同じブラウザで進行役が参加者（1 役割）を兼ねられます**。残りの 3 役割は、開発用ボットが担当します。

```bash
npm run dev                         # 端末 1: DB・API・UI を起動
# ブラウザで http://localhost:5173 を開き「ゲームを作る」→ 参加コードが表示される
npm run dev:bots -- <参加コード>    # 端末 2: ボット 3 体が参加し、割り当て後は毎週 4 を発注する
```

1. 同じブラウザで「参加する」を開き、自分も参加する（進行役のまま）。
2. ロビーで、自分とボット 3 体に役割を割り当て、「開始する」。
3. 自分の画面で発注を保存する。「全員が保存したら自動で次の週に進む」（作成時の既定）なら、ボットの発注がそろった時点で自動で次の週に進む。これを最終週まで繰り返す。
   作成時にこのチェックを外した場合は、メニューの「進行役コンソール」で「週を確定する」を押す。

振り返りの確認には、増幅が現れる発注方式のボットを使う: `BOT_STRATEGY=reactive npm run dev:bots -- <参加コード>`（受注・受注残・在庫の差で発注する。上流ほど注文が大きく揺れる）。ゲームを終えると、メニューの「振り返り」で、役割別の推移を見られる。

起動できないとき: ポート 3000 / 5173 が他のプロセスに使われていると、UI は起動に失敗します（API の許可 Origin が 5173 固定のため、別ポートで動かさない）。`lsof -nP -iTCP:5173 -sTCP:LISTEN` で確認して止めてください。

## 検証

```bash
npm run verify         # format → lint → typecheck → テスト+カバレッジ → 受入条件の対応 → E2E
npx playwright install chromium   # 初回のみ
```

- 統合テストは専用の DB `beer_game2_test` を自動で作成し、接続先がこの DB であることを確認してから初期化します。DB に接続できなければ**スキップせず失敗します**。
- カバレッジのゲートは、行・関数・文 85%、分岐 75%（`src/domain`、`application`、`adapters/http`、`adapters/persistence`）。

## 確認項目

- `GET /health` は常に 200。`GET /ready` は DB に接続できないと 503 になり、復旧すると 200 に戻る。
- ログは構造化 JSON で、資格・表示名・Cookie を含まない。
