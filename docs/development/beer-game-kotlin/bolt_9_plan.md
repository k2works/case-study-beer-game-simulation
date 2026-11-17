---
type: Plan
title: "Bolt 9 計画 - 観察者（Kotlin 版）"
description: "beer-game-kotlin の Bolt 9（Unit U4 の 2 つ目）のステップ計画。観察用の招待の発行・失効、観察者の参加、公開範囲内のチーム合計の観察、観察者の権限の制限。/goal U4 に基づく自律実行の記録。ゲートは未承認。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-17T14:00:00Z }
---

# Bolt 9 計画 - 観察者

> **承認の状態について**: 本書は、ユーザーの `/goal U4`（Unit U4 を完了する）に基づいて、AI が計画を書いたうえで実装した記録です。**判断項目とゲートの個別の承認は、受けていません（すべて未承認）。** 実装の結果は [bolt_9_report](./bolt_9_report.md)。

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B9（[リリース計画](./release_plan.md)）。U4 の 2 つ目 |
| 対象 | AC1.3.1〜1.3.4、AC4.1.1〜4.1.5、観察者への振り返りの終了後の開示 |
| アプローチ | インサイドアウト。日本語 Gherkin（`@api`）→ ドメイン（招待・観察者の参加）→ 投影 → アプリケーション（開示の規則）→ HTTP・契約 → UI。TDD（Red → Green） |
| 仮説 | 観察者を `Actor` と資格に足し、既存の表（`lobby_observer_invitations`、`lobby_observers`、`week_team_totals`）だけで、スキーマを変えずに実現できる |

## 判断項目（AI の提案どおりに進める。未承認）

| # | 項目 | 案 |
| :-: | :--- | :--- |
| 1 | 招待コードの保管 | 値はイベントに入れない。`credentials` の行（`kind = OBSERVER_INVITATION`、`subject_id` = 招待 ID、ダイジェストだけ）に保管し、コードからゲームと招待を引く。値は発行の応答だけが運ぶ（再表示しない）。スキーマ変更なし |
| 2 | 招待コードの形 | 参加コードと同じ乱数（12 文字）に、資格の鍵の版の接頭辞（`v1.`）を付けた値。参加コードとは別の乱数・別の鍵付きダイジェストで、参加コードとして使えない |
| 3 | 招待の有効期間 | 発行から 7 日（設計の未決の既定値の仮置き）。人数の上限は設けない（設計の未決） |
| 4 | 招待の無効 | 不明・失効・期限切れは区別せず、403 `game.invitation_invalid`（参加コードと同じ本文）。観察用の招待の試行も、参加と同じ接続元の窓で数える |
| 5 | 観察者の資格 | ブラウザセッション（`bg_session`、`actor_kind = OBSERVER`）だけ。復帰資格は発行しない（観察者の復帰の要否は設計の未決。失効・再発行の対象も参加者だけのまま） |
| 6 | 経路 | `POST /games/{id}/observer-invitations`（発行）、`POST /games/{id}/observer-invitations/{invitationId}/revoke`（失効）、`POST /participations/observe`（観察者の参加）、`GET /games/{id}/observation`（観察） |
| 7 | 観察を開ける人 | 観察者と進行役。参加者・無資格は 403（AC4.1.4 の原文どおり、観察者の立場に限る。設計の S07 の「参加者」は、BR-17 により採らない。進行役は、すべての情報を持つ側として許す） |
| 8 | 観察の内容 | 状態・最終週・現在週・入力済みの役割数・確定済みの週のチーム合計（注文・在庫・受注残）。役割別の値・将来の需要・参加コード・入力者は含まない |
| 9 | 抑止 | 公開範囲が `NONE` なら合計を出さない。寄与者が 2 未満の週は値を出さず、理由（`CONTRIBUTORS_BELOW_MINIMUM`）だけを返す |
| 10 | 状態・振り返りの経路 | 観察者は `GET .../state`・`.../lobby`・`.../sessions/.../state` を 403（資格の失敗と同じ本文）。`GET .../review` は終了後だけ開示（終了前は 409 `game.not_ended`） |
| 11 | DB ロール | 観察の読み取りは、観察者用の読み取りポート（`ObservationReader`）に分け、`game_overview`・`session_overview`・`week_team_totals` の 3 表だけを読む。PostgreSQL では、設定 `DB_OBSERVER_ROLE` を指定したときだけ、別の接続プール（`SET ROLE`）を使う。未指定は、主のプールと同じ接続。ログイン用のユーザーの作成は B3 以降の運用（未実施） |
| 12 | 公開範囲の読み取り | 観察者のロールは `game_settings` を読めないため、公開範囲だけは、主の読み取りポートから読む（値は作成時から変わらない） |
| 13 | 画面 | S10 `/observe`（参加）、S07 `/games/:id/observation`（観察）、ロビーの観察用の招待の発行・失効（進行役） |

## ステップ

1. 受入シナリオ（`@api`）を書き、Red にする
2. ドメイン（`InviteObserver`・`RevokeObserverInvitation`・`JoinAsObserver`、`Actor.Observer`）と単体・プロパティテスト
3. 永続化（EventCodec・DTO・golden）、投影（`lobby_observer_invitations`・`lobby_observers`・`week_team_totals`）、周辺ストア（招待コードの照合、観察者のセッション）
4. アプリケーション（コマンド、`Disclosure.forObservation`、`observe`）
5. HTTP・契約（`openapi.yaml`、型の再生成、契約テスト）、観察者用の接続プール
6. 画面（S10、S07、ロビーの招待）。コンポーネントのテストを先に書く
7. `@ui` 1〜2 件、全検査、報告書

## 更新履歴

| 日付 | 内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-17 | `/goal U4` に基づく自律実行のため、計画を書いて実装した。**判断項目・ゲートは未承認** | claude-code/claude-sonnet-5-5 |
