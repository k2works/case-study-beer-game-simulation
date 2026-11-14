# 試験の手順 - U4 u4-access-recovery

U4（復帰と権限）の試験の手順です。U1〜U3 の試験の方針を引き継ぎ、U4 の試験だけを `tests/u4` に置きます。

## 試験の構成

| 種類 | 置き場 | 内容 |
| :--- | :--- | :--- |
| 単体 | `apps/beer-game3/tests/u4/unit/` | AccessControl（観察者、操作の表、期限、無効な token の同一の結果）、投影の型、接続元の正規化、設定の検査 |
| 結合 | `apps/beer-game3/tests/u4/integration/` | 試行の窓（PostgreSQL）、条件付き更新、掃除、移行、再起動、経路の表の網羅 |
| 構造 | `apps/beer-game3/tests/u4/unit/` | 入口から GameSession の import の禁止、経路の表と登録の差 |
| 画面 | `apps/beer-game3/tests/u4/web/` | 観察者の入口、観察画面、顧客需要、切断中の表示 |
| 補助 | `apps/beer-game3/tests/u4/support/` | 時計（`FixedClock`）、2 つのアプリケーションを起動する補助、接続元を指定する補助 |

## 事前準備

- Node.js 26（`nvm use 26`）、PostgreSQL 18（`beer-game3-pg`、ポート 55432）が動いていること。
- 試験用のデータベース: `postgres://postgres:postgres@localhost:55432/beer_game3_test`。
- 人の開発サーバー（ポート 3000・5173）は止めない。画面の E2E が必要な場合は専用のポート（3100・5273）を使う。

## 実行するコマンド

U4 の試験だけを実行する（プロジェクト全体は実行しない）:

```bash
. ~/.nvm/nvm.sh && nvm use 26 >/dev/null && DATABASE_URL=postgres://postgres:postgres@localhost:55432/beer_game3_test npm --prefix apps/beer-game3 run test:u4
```

（`exec -- vitest` はリポジトリ直下を root にして他のアプリの試験まで拾うため使わない。`test:u4` は `package.json` に追加済み。）

Unit の検証（承認済みの検証コマンド。全 Unit の試験と lint、型検査を含む）:

```bash
. ~/.nvm/nvm.sh && nvm use 26 >/dev/null && DATABASE_URL=postgres://postgres:postgres@localhost:55432/beer_game3_test npm --prefix apps/beer-game3 run verify
```

## カバレッジ

- 行カバレッジは 80% 以上（`vitest.config` の閾値）。閾値は下げない。
- U4 で足すモジュール（窓、接続元の正規化、AccessControl の追加分、掃除）は、行カバレッジ 80% 以上を目標にする。

## 方針

- 振る舞いの例（Given/When/Then）を先に書き、失敗を確かめてから実装する（BDD）。土台を変える最初のスライドの後続の試験も先に書く。
- 時刻は `FixedClock` で進め、24 時間 ± 1 分と 60 秒の境界を確かめる。待つ試験（実時間の sleep）を作らない。
- 窓の並行の試験は、実際の PostgreSQL に対して、同じ接続元から同時に 20 件を送り、通るのが 10 件までであることを確かめる。2 つのアプリケーションは、同じデータベースに 2 つのサーバーを立てて確かめる。
- 認可の網羅試験は経路の表を元にし、表に無い経路が登録されたら失敗する。
- 資格情報の文字列がログに出ないことを、ログの出力を捕まえて確かめる。

## 試験データ

- 4 役割が揃ったゲーム（`tests/u1/support/world.ts` の補助）に、観察者用コードを発行して使う。
- 第 10 週まで確定したゲームと、第 5 週で小売店が入力済みで未確定のゲームを、再起動の試験に使う。
- 接続元は、試験の補助で指定する（IPv4、同じ /64 の別 IPv6 アドレス、IPv4 射影アドレス）。
