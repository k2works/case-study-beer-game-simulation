# 試験の手順 - U5 u5-results-retention

U5（結果と出力、保持と削除）の試験を、この Unit だけで実行する手順です。試験の枠組み（Vitest、Testing Library、Playwright）は U1 から使っているものをそのまま使い、新しく足しません。

## 実行環境

- Node.js 26（`. ~/.nvm/nvm.sh && nvm use 26`）、PostgreSQL 18（`localhost:55432`。結合の試験用に `beer_game3_test`）
- 作業は `apps/beer-game3` で行う。結合の試験は `DATABASE_URL=postgres://postgres:postgres@localhost:55432/beer_game3_test` を渡す
- 開発用のサーバー（3100）と画面（5273）は止めない。試験は専用のデータベースとメモリ上の保存を使う

## この Unit だけの実行コマンド

```
cd apps/beer-game3
npx vitest run tests/u5/features tests/u5/unit            # 振る舞いと単体（メモリ上の保存）
DATABASE_URL=postgres://postgres:postgres@localhost:55432/beer_game3_test npx vitest run tests/u5/integration   # 結合（PostgreSQL）
npx vitest run tests/u5/web                               # 画面
```

U5 の試験は `tests/u5/` の下にだけ置く。全体の検証（`npm run verify`）は Construction Verification Command が行い、U5 のコマンドには含めない。U1〜U4 の試験は U5 の変更で壊れないことを、全体の検証で確かめる。

## 試験の構成（Standard: 部品ごとに 5〜8 件、境界の結合）

| 区分 | 場所 | 内容 |
| :--- | :--- | :--- |
| 振る舞い（Given/When/Then） | `tests/u5/features/*.spec.ts` | 受入条件 AC4.1.1〜AC5.1.3 を、メモリ上の保存で上から下まで通す。結果、出力、保持と削除、自動終了、表示名の拒否、最後の操作の時刻 |
| 単体 | `tests/u5/unit/*.spec.ts` | `buildResultsView`、`buildExportRecords`、`renderCsv`（読み戻しと性質の試験）、`renderJson`、`isExpired`、`isStale`、`loadRetentionPolicy`、`FailureMemory`、`RetentionJob.runOnce`（時計を指定）、`scheduler`（連続の失敗の回数、停止）、構造の試験（入口が Reporting と Retention を import しない、経路の表の網羅、`games` を参照する外部キーの連鎖） |
| 結合（PostgreSQL） | `tests/u5/integration/*.spec.ts` | 移行（補完の SQL と索引）、連鎖削除（全表の行が 0 件）、削除の原子性（障害の注入）、`runExclusive` の二重実行の防止（接続 2 本）、`readSnapshot` と削除の重なり（403 と完全な 200 の 2 通り）、再起動を挟んだ結果の一致、自動終了の再検査（選んだ後の操作）、対象の選択と除外（空配列を含む） |
| 画面 | `tests/u5/web/*.spec.tsx` | 結果画面（指標と費用の切り替え、線種と印と凡例、表の併記、キーボード操作）、出力ボタンの注意と列名の説明の同時表示、終了後だけ出る導線、表示名の入力の拒否の表示、金額の表示 |

## 時刻の扱い

時刻は注入した時計（`FakeClock`。U1 の試験の補助）で進める。期限の境界は次の 3 点を試験する: 期限の直前（対象外）、期限ちょうど（対象）、期限の直後（対象）。保持期間は既定の 30 日と 7 日、自動終了は 30 日。

## モックとテストデータ

- メモリ上の保存と PostgreSQL の保存は同じ契約の試験（契約の試験）を通す。U5 の保存の関数も、両方で同じ結果になることを確かめる
- テストデータは `tests/u5/support/harness.ts` の組み立て（ゲームの作成、4 役割の参加、N 週の確定、終了）で作る。50 週のゲームは、既知の入力系列から作る
- 表示名の試験データ: カンマ、二重引用符、改行、先頭が `=`、`+`、`-`、`@`、日本語、絵文字、40 文字
- 障害の注入は、保存の関数を差し替える（メモリ上の保存）と、トランザクションの途中で例外を起こす（PostgreSQL）

## 期待するカバレッジ

行 80% 以上（全体の閾値。`vitest.config.ts` の `thresholds` は変えない）。U5 が足すファイル（`reporting/`、`retention/`、`ResultsScreen`、`ExportPanel`）は、いずれも行 85% 以上を目安にする。閾値を下げて通すことはしない。
