# 担当の割当て（Team Allocation）

どの Bolt を、だれが作るかを定めたものです。Bolt は、作る作業の一部分を 1 回通して、動くものを残す単位です（順序は `bolt-plan.md`）。モブ（mob）は、複数の担当が同じ作業に一緒に取り組む形のことです。

## 前提

- チームの編成の工程（team-formation）は、この作業の範囲に含まれていません。したがって、すべての Bolt を aidlc-developer-agent（AI）が作ります。
- 人は、各 Unit の承認で、設計の判断とコードを検証します。重要な判断は、人の承認を経ます（AI-DLC の承認ゲート）。
- 並行して作りません（`delivery-planning-questions.md` の Q3 の A）。したがって、複数のチームの調整に使う Program Board（複数チームの作業と依存を 1 枚に並べる表）は、この計画では不要です。

## 割当て

| Bolt | Unit | 担当（作る） | 検証する人 | 備考 |
| :--- | :--- | :--- | :--- | :--- |
| B1 | U1 u1-walking-skeleton | aidlc-developer-agent | 人（薄い一通りの承認） | 薄い一通り。人が承認するまで B2 以降を始めない |
| B2 | U2 u2-weekly-rules | aidlc-developer-agent | 人（Unit の承認） | 週次ルールの golden test を含む |
| B3 | U4 u4-access-recovery | aidlc-developer-agent | 人（Unit の承認） | セキュリティに関わる実装。権限の検証を人が確かめる |
| B4 | U3 u3-facilitation | aidlc-developer-agent | 人（Unit の承認） | |
| B5 | U5 u5-results-retention | aidlc-developer-agent | 人（Unit の承認） | 削除の処理は個人情報に関わる |
| B6 | U6 u6-nfr-verification | aidlc-developer-agent | 人（Unit の承認） | 負荷試験、アクセシビリティ、ブラウザの検査 |

## 設計の助言

- aidlc-architect-agent は、各 Bolt の前の設計（Functional Design と NFR）で、Unit の境界と契約の整合を見る。
- 作る担当と検証する人は分ける。AI が作ったコードは、人が全行を理解してから承認する。

## 上流の資料

`bolt-plan.md`、`unit-of-work.md`、`team-practices.md`
