---
type: Reference
title: "Bolt 7 終了報告 - 共同担当と共同入力（Rust 版）"
description: "beer-game-rust の Bolt 7 の結果。共同担当・共同入力の競合・開始後の役割の入れ替え・契約テストの導入。許可リストと @ui の通過数、契約テストが見つけた逸脱、簡略化、人の判断が要る項目、B8 への申し送り。"
tags: [report, plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-22T00:00:00Z }
---

# Bolt 7 終了報告（Rust 版）

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B7（U2。計画は [bolt_7_plan](./bolt_7_plan.md)。2026-11-22 にユーザーが承認） |
| 状態 | **実装と記録は完了。人のゲート・コードの全行理解は未承認・未実施。** |

この報告は実装の事実と、人が判断・検証すべき点を示すものです。**承認の記録ではありません。**

## 承認の扱い

計画の承認（2026-11-22）のもとで進め、個別の承認が要る項目は着手前に確認しました。

| 項目 | 結果 |
| :--- | :--- |
| DDL: マイグレーション 0008（`lobby_participants.replaced_at`） | 2026-11-22 にユーザーが承認（Kotlin 版 V007 と同じ。拡張のみ） |
| 新規依存: `jsonschema` 0.62.0（開発時のみ、`default-features = false`）、YAML は `serde-saphyr` 2.2.0（開発時のみ） | 2026-11-22 にユーザーが承認。**当初の `serde_yaml_ng` は `cargo deny` が通らず**（`unsafe-libyaml` が保守されていない: RUSTSEC-2024-0449）、ユーザーの選択（「saphyr 系へ変更」）で `serde-saphyr` にした |
| `deny.toml` に **MIT-0** を許可 | 2026-11-22 にユーザーが承認（`jsonschema` の推移依存 `borrow-or-share` のライセンス） |

## 完了条件の達成状況

| 完了条件 | 結果 | 根拠・注記 |
| :--- | :--- | :--- |
| 共同担当（AC1.2.4・AC1.2.5） | 達成 | `co-assignment.feature` の 4 シナリオが通る。**実装は B1 から変えていなかった**（1 人 1 役割の写像が、同一役割に複数行で表せる）。足したのはステップ定義だけ |
| 共同入力（AC2.1.4・AC2.2.3・AC2.2.4・NF-C8・確定の区別） | 達成 | `co-input.feature` の 12 シナリオが通る。状況に **保存者（`decisionEditor`）・保存の時刻・共同担当（`coHolders`）** を足し、競合（`session.decision_conflict`）と確定の根拠の変化（`session.decisions_changed`）の応答に、最新の入力の保存者・時刻を添えた。表示名は同じ役割の参加者と進行役にだけ示す |
| 役割の入れ替え（AC3.2.5。開始後） | 達成 | `credentials.feature` の後半 8 シナリオが通る。役割を持たない参加者を担当者のいる役割へ割り当てると、**担当者全員が外れ、資格（復帰資格とセッション）が同じトランザクションで失効**。履歴と入力者のラベルは残る |
| 契約テストの導入と、B5〜B7 の API への適用 | 達成 | `crates/app/tests/contract.rs`。共有する `openapi.yaml`（変更しない）のスキーマで、作成・参加・復帰・失効・再発行・状態・停止・再開・代理入力・確定・競合・振り返りの応答を検証。CI の `cargo test --workspace` で実行 |
| 品質チェック一式が緑 | 達成 | `just backend-check` 終了コード 0。domain の行 100%、全体の行 93.1%、`cargo deny` 緑 |

### 通過数

| 指標 | B6 終了時 | B7 終了時 |
| :--- | ---: | ---: |
| 許可リストの `@api` シナリオ（`just acceptance`。アウトラインを展開後） | 65 | **89**（ステップ 625 すべて通過） |
| 許可リストの対象（全 `@api` 159 件のうち） | 57 | **81**（未対応 78 件） |
| `@ui`（`just ui-acceptance`。`web/` は無変更） | 19 / 27 | **20 / 27** |

## 仮説の検証結果

| 前提 | 結果 |
| :--- | :--- |
| 並行の保存で更新を失わないか | **成立**。同じ版から 2 人が保存すると 2 人目は `session.decision_conflict`（409）で、1 人目の入力が残る。競合した保存は版も回数も進めない |
| `GameData.participants` を複数人に対応させても既存が保たれるか | **成立（変更不要）**。同一役割に複数行で表せる。入れ替えのために、`revoked`（失効した参加者）だけを足した |
| 契約テストで、追加した API の応答を `openapi.yaml` と機械的に照合できるか | **成立**。**照合して、実際の逸脱を 1 件見つけた**（下） |

## 契約テストが見つけた逸脱

- **`Problem` の本文に `correlationId` が無かった**（契約は必須）。B2 から、すべてのエラー応答が違反していた。`problem_response` が本文にも相関 ID を入れるよう修正（ヘッダー `x-correlation-id` は従来どおり）。
- 他の応答（`CreateGameResponse`・`JoinResponse`・`RecoverResponse`・`ReissueResponse`・`SessionState`・`GameState`・`Review`・`CommandResponse`・`ConflictProblemBody`）は適合していた。

## 簡略化と未達（人の判断が要る項目）

1. **入れ替えは `game` と `session` の 2 本のストリームに追記する**ため、`execute_start` を `execute_both` に一般化した（開始と同じ原子性）。応答の版は、`session` へ追記しないとき（準備中の割り当て）は `game` だけ。
2. **契約テストの範囲**は、B5〜B7 で追加した API の「成功の応答」と、代表的な problem（409）。`openapi.yaml` の全パス・全ステータスの網羅ではない。自動生成の網羅は B8 以降で広げる。
3. **契約テストの YAML パーサ**は `serde-saphyr` 2.2.0。ユーザーが「saphyr 系」を承認したが、**具体の版（2.2.0）は導入のときに決めた**。
4. 状況の `coHolders` は、入れ替えられた旧担当者を含めない（`role` を NULL にするため）。`replaced_at` は書くが、問い合わせではまだ使っていない。
5. 認証が `execute` の外である点は、B6 で承認済み（簡略化の継続）。
6. TDD の順序: 共同担当・共同入力は、実装が既にあった部分が多く、ステップ定義を先に書いて通るかを確かめる形（Red が出たのは状況の保存者・競合の保存者・入れ替え）。入れ替えのドメインは、失敗するテストを先に書かずに実装と同時に書いた。人が判断。

## 人の判断が要る項目（まとめ）

1. 上記の簡略化と未達。
2. **守り（hook・必須ジョブ）の導入計画**: B6 から継続（承認の記録どおり、着手前に計画を示して確認。**未提示**）。
3. 設計書への反映（0007・0008、`EventCodec::actor`、`execute_both`、鍵のローテーション、`correlationId`、`ProxyDecisionSubmitted`・`ParticipantReplaced` など）と `verified` の再確認。
4. B1〜B7 のゲートとコードの全行理解。

## B8 への申し送り

- 使える土台: `execute_both`（2 本のストリームの原子的な追記）、`Attempt`（試行の窓）、`SealedIdempotency`、契約テストの土台（`contract.rs`。新しい API は同じ形で足す）。
- B8（カスタム条件）で必要: `CreateGameRequest` の `conditions`（初期在庫・遅延・単価・公開範囲）、可変の遅延の `simulate_week`、`custom-conditions.feature`（API と UI）。契約（`openapi.yaml`）は変更不要の見込み。

---

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-22 | 初版作成（人のゲートは未承認） | claude-code |
