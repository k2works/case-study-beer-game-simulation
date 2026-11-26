---
type: Reference
title: "Bolt 4 終了報告 - 進行の継続と資格（Scala 版）"
description: "beer-game-scala の Bolt 4 の結果。停止・再開・代理入力、復帰、資格の失効・再発行・鍵のローテーション、開始後の役割の入れ替え、試行の窓。完了条件の達成状況と、未承認の判断。"
tags: [report, plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-26T10:40:00Z }
---

# Bolt 4 終了報告（Scala 版）

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B4（U2。[リリース計画](./release_plan.md)） |
| 期間 | 2026-11-26（1 セッション。`/goal orchestrating-development U2` による AI の連続実行。計画は 1.5 日） |
| 状態 | **実装と記録は完了。人のゲートの承認・個別の Bolt 計画の承認は未記録。** B4 の個別計画書は作っていない（リリース計画の記述だけで着手した） |

この報告は事実と、人が判断すべき点を示します。**承認の記録ではありません。** `/goal` は承認ではありません。

## 完了条件の達成状況

| 完了条件 | 結果 | 根拠 |
| :--- | :--- | :--- |
| AC3.1.1〜3.1.3（停止・代理入力・再開） | 達成 | `continuation/pause-resume.feature` の 12 シナリオ |
| AC3.2.1〜3.2.4（復帰） | 達成 | `continuation/recovery.feature` の 10 シナリオ（例の展開を含む） |
| AC3.2.5（失効・再発行・期限・鍵のローテーション・役割の入れ替え） | 達成 | `continuation/credentials.feature` の全シナリオ |
| 鍵のローテーションと失効後の再送の否定テスト | 達成 | 旧版の鍵を外すと復帰もブラウザセッションも 403。失効した資格の同じキーの再送も 403 |
| 冪等記録の照合を認可の後に置く（ADR-004） | 達成 | `idempotentAuth`・復帰の `valid` の事前確認 |
| 試行の窓（NF-S11・NF-S19） | 達成 | `game-setup/join-rate-limit.feature`（上限 10 回・窓 10 分は、未計測の仮置き） |
| CI 緑 | 確認済み | 3 ジョブ緑（B5 のコミットで確認） |

許可リストは 87 シナリオ・606 ステップ、すべて緑。行カバレッジは全体 89.6%、domain 96.6%、application 94.3%。

## 仮説の検証結果

| 仮説 | 結果 |
| :--- | :--- |
| 資格の設計は、漏洩時に被害を止められるか | 成立。失効はブラウザセッションの削除と復帰資格の失効を同じトランザクションで行う。入れ替えでも担当者全員が失効する |
| 失効した資格の再送は 403 か | 成立。認可が冪等記録の照合より先 |

## 簡略化・設計判断（未承認。人の判断が要る）

| 項目 | 内容 |
| :--- | :--- |
| マイグレーション V004（`recovery_credentials`）・V005（`attempt_failures`） | **確認必須（データベース）。未承認** |
| 資格の鍵の版（`KeyRing`。HMAC-SHA256。トークン `v<版>.<乱数>`） | ADR の根拠が無い設計。鍵は環境変数 `BGS_CREDENTIAL_KEY`（無ければ起動ごとの乱数）。Secrets Manager 連携は未実装 |
| 接続元の取得に `X-Forwarded-For` の先頭を無条件に信用 | **リスク**: ALB の背後以外では、クライアントが偽装して窓を回避できる。信頼するプロキシの設定が要る |
| 復帰コードは作成・再発行の応答で一度だけ示し、冪等記録には残さない | 冪等の再送では、復帰コードを再表示しない（Cookie の再発行をしない簡略化と同じ） |
| 新しい code（`session.paused`・`session.not_paused`・`session.save_limit_reached`・`game.credential_already_revoked`・`game.credential_not_revoked`・`app.rate_limited`） | 契約（openapi.yaml）の提案どおり。UI の辞書への追加が要る |
| 失効の対象は参加者だけ（進行役自身の資格は範囲外） | 契約の記述どおり |
| 読み取りモデルの投影表なし（B1 から継続） | 保存の時刻は、イベントの追記の時刻から返す（B5） |

## Living Documentation（`apply-living-documentation`）

| 観点 | 判断 |
| :--- | :--- |
| 書く | 設計判断（認可の順序、鍵の版、X-Forwarded-For のリスク）をこの報告とコードのコメントに残した |
| リンク | 受入条件は共有の Gherkin にリンク。API は `openapi.yaml` に委ねた |
| 生成 | 用語集・図の自動生成は未導入（B15 で判断） |
| 書かない | クラス一覧・状態遷移の一覧は手書きしない |
| 設計文書との複製 | 設計書（`docs/design/beer-game-scala`）は、資格の鍵の版・試行の窓・入れ替えの 2 ストリーム化を**まだ反映していない**（承認後に反映） |
