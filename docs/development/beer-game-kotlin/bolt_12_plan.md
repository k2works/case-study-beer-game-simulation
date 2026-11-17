---
type: Plan
title: "Bolt 12 計画 - 投影の再構築・整合検査・スキーマ進化（Kotlin 版）"
description: "beer-game-kotlin の Bolt 12（Unit U5 の 2 つ目）のステップ計画。投影の再構築（排他のアドバイザリロック）、投影の整合検査、EventCodec のアップキャストと読む版・書く版の分離、N-1 互換の検査。/goal U5 に基づく自律実行の記録。ゲートは未承認。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-17T20:00:00Z }
---

# Bolt 12 計画 - 投影の再構築・整合検査・スキーマ進化

> **承認の状態について**: 本書は、ユーザーの `/goal U5`（Unit U5 を完了する）に基づいて、AI が計画を書いたうえで実装した記録です。**判断項目とゲートの個別の承認は、受けていません（すべて未承認）。** 実装の結果は [bolt_12_report](./bolt_12_report.md)。

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B12（[リリース計画](./release_plan.md)）。U5 の 2 つ目。Kotlin 固有の Bolt（ユーザーストーリーの受入条件はない） |
| 対象 | NF-R15（投影の再構築の一致）、NF-P18（再構築の時間）、NF-R16（往復の同値性）、NF-O11（N-1 互換）、リスク R8・R9 |
| アプローチ | インサイドアウト。日本語 Gherkin（`@api`、`@NF-R15`）→ 永続化（再構築、整合検査、`EventCodec` のアップキャスト）→ アプリケーション（保守のサービス）→ 起動モード（`rebuild-projections`、`verify-projections`）→ N-1 互換の検査。TDD（Red → Green） |
| 仮説 | `events` から投影を作り直した行は、増分で書いた行と一致する。作り直しは、排他のロックの下で 1 トランザクションに収まり、研修中の運用は停止の依頼で成立する |

## 判断項目（AI の提案どおりに進める。未承認）

| # | 項目 | 案 |
| :-: | :--- | :--- |
| 1 | スキーマ変更 | **なし**（設計書の表のまま。マイグレーションは足さない） |
| 2 | 再構築の単位 | ゲームごとに 1 トランザクション。排他のロック（`ProjectionLock.acquireExclusive`）を先頭で取り、投影の 13 表と `projection_checkpoints` の当該ゲームの行を消し、`events` を追記順（`seq`）に読み直して、同期投影と同じ書き込み（`ProjectionWriter`）で作り直す。全ゲームは 1 ゲームずつ順に行い、1 ゲームの失敗が他に波及しない |
| 3 | 再構築の対象外 | 削除の進行（`deletion_*`）は、イベントから導けない状態なので対象外。周辺ストア（`credentials`・`browser_sessions`・`idempotency_records`・`display_profiles`・`participation_attempts`）も、秘密の値を持ち、イベントから作れないので対象外。リリース計画・B11 の報告書にある「`retention_policies` の補充」は、投影の表なので対象 |
| 4 | イベントの読み順 | 追記順（`events.seq`）。2 本のストリーム（GAME・SESSION）が同じ行を更新するとき、元の更新の順になる |
| 5 | 整合の検査 | (a) `projection_checkpoints.projected_version` と `MAX(stream_version)` の一致（ストリームごと）、(b) 投影の全行が、再構築した行と一致。(b) は、同じトランザクションで「再構築 → 行を比べる → ロールバック」を行い、比較の正規化（JSON・時刻の表現）を DB に任せる。排他のロックを待ちの上限まで待ち、取れなかったゲームは「検査できなかった」として別に数える（不一致には数えない） |
| 6 | 再構築の結果 | 再構築の前後の行を比べ、**変わった行数**を報告する（0 なら一致。B11 より前のゲームの補充や、列の追加の埋めは、変わった行として現れる）。再構築は変わっていても確定する |
| 7 | 起動モード | `rebuild-projections [ゲーム ID ...]`（無指定は全ゲーム）。`verify-projections`（定期の整合検査。日次）。終了コード: 0 正常、1 再構築できなかったゲームがある／不一致が見つかった、70 起動・接続の失敗。DB のロールは `beergame_writer` の権限で足りる（`DB_DELETER_ROLE` のような切替は足さない） |
| 8 | 研修中の運用 | 設計どおり、運営者を通じた進行役への停止の依頼と、排他ロックによる直列化（M23）。ロックの待ちの上限は、既存の `lock_timeout`（5 秒）。再構築中のコマンドの応答（待つか 503 か）は、既存の挙動（待ちの上限で 503 `app.retry_exhausted`）のまま。**未決のまま**（設計の未決事項。報告書に再掲） |
| 9 | アップキャスト | `EventCodec` に、読める版の範囲（`READABLE`。1..最新）と、書く版（`WRITE`）を分け、版ごとのアップキャスト（イベントの種類・旧版 → 旧版 + 1 の純粋関数。JSON のオブジェクトを変換）を連ねる。**現在、形が変わったイベントはないので、本番のアップキャスト関数は 0 個**（版は 1 のみ）。仕組みは、試験用の合成の版（v2）で検証する。書く版の切り替えの持ち方（環境変数か設定サービスか）は設計で未決のため、**実装しない**（書く版は定数 1） |
| 10 | golden | 全イベントの種類の golden を、`adapter-persistence/src/test/resources/golden/v1/events.json`（書く版 1 のイベントの例の保存）に固定する。`EventGoldenSpec`（既存の 21 種類）と、ファイルの内容が一致することを確かめる。**過去の版の golden は変更しない**（版を上げるときは、新しいディレクトリを足す） |
| 11 | N-1 互換の検査 | (a) `N1CompatibilitySpec`: `golden/` の全ディレクトリ（過去の版）のイベントを、現在のコードで読める（アップキャストして復号できる）。(b) `scripts/n1-compat.sh <直前のタグ>`: 直前のリリースのタグを `git worktree` で取り出し、**現在の golden と、読み取りの検査だけを**そこへ複写して、旧版の読み取り側で実行する。CI の `n1` ジョブは、このスクリプトを呼ぶ（タグが無い間は、実行しない）。タグが存在しないため、**GitHub Actions 上と、本物のタグでの実行は未確認**。ローカルでは `HEAD` を直前の版とみなして実行する |
| 12 | 再構築の時間（NF-P18） | 統合テスト（PostgreSQL）で、最終週が最大のゲームの再構築の時間を計測して記録する（目標は実測で決める。合否は置かず、極端な遅さ（10 秒超）だけ失敗にする）。100 ゲームの計測は B15 |
| 13 | 受入（`@api`）の窓口 | `ProjectionHarness`。本番の `rebuild-projections` と同じサービス（`ProjectionMaintainer`）を、同じ永続化の実装に対して行う。投影の破壊（行を空にする・書き換える）は、試験が保存先を直接書く（本番のコードではない） |
| 14 | API・画面 | 作らない（運用向けの API は設計にない）。契約の変更なし。`@ui` なし |

## ステップ

1. 計画書（本書）と受入シナリオ（`features/operations/projection-rebuild.feature`）を書き、Red にする
2. アプリケーション（`ProjectionMaintenance` のポート、`ProjectionMaintainer` のサービス）
3. 永続化（`JdbcProjectionMaintenance`: 再構築・整合検査、`Persistence.maintenance`）と、契約テスト（H2・PostgreSQL。排他ロックの待ち・投影の不一致・補充）
4. `EventCodec` のアップキャストと読む版・書く版の分離、golden のファイル、`N1CompatibilitySpec`
5. 起動モード（`rebuild-projections`・`verify-projections`）、Dockerfile・コンテナのスモーク・Terraform の注記・手順書の更新
6. N-1 互換の検査（`scripts/n1-compat.sh`、CI の `n1` ジョブ）
7. 全検査、報告書、`release_plan.md` の進捗表

## 更新履歴

| 日付 | 内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-17 | `/goal U5` に基づく自律実行のため、計画を書いて実装した。**判断項目・ゲートは未承認** | claude-code/claude-sonnet-5-5 |
