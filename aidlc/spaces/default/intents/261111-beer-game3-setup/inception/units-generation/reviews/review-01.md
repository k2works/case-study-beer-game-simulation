## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-12T01:32:15Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/units-generation/unit-of-work.md > U1 境界 / U3 境界 / U4 境界 | 参加者を個人として識別する仕組み（復帰用 token）は、U1 では「参加コードと進行役用コードの発行・検証」にしか含まれず、ReturnToken は U4 の境界に置かれている。しかし U1 の US1.4（AC1.4.1: 小売店の参加者が他役割の在庫を要求しても拒否）は、要求者の役割を特定できなければ成立しない。また U3 の AC2.6.1（入れ替え時に以前の担当者の復帰用 token を無効にする）と AC2.2.1（もう一方の人の画面に置き換わりを示す）も、U3 は U4 に依存しないため token がない時点では満たせない。 | U1 の境界に、参加者の識別に最小限必要な資格情報（役割に結びつく token の発行と検証）を加える。U4 は有効期間・失効・試行回数の制限を足す、と責務を分ける。あわせて AC2.6.1 の token 失効が U3 のどこで担保され、U4 でどう仕上がるかを U3 の制約に書く（または U3 から U4 への依存を認める）。 | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/units-generation/unit-of-work-dependency.md > 依存の定義 u5-results-retention | U5 の依存は U3 のみで、U4 とは依存がなく並行できると書かれている。ところが US5.1 は個人情報を持ち続けないための削除であり、AccessControl が持つ AccessCode と ReturnToken（participantId を持つ）も削除と無効化の対象になる。U4 が U5 より後に完成した場合、U5 の削除はまだ存在しない ReturnToken を扱えず、U4 が U5 の削除に組み込む作業が必要になるが、どちらの Unit の責務かが定まっていない。 | 削除の対象に AccessControl の実体（AccessCode、ReturnToken）を含めることを U5 の境界と接点に明記し、U5 と U4 の順序で何が起きるか（U5 が U4 に依存する、または U4 が削除の接点を提供する）を決める。 | New |
| R-03 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/units-generation/unit-of-work-story-map.md > 複数の Unit にまたがる関心事 > 履歴の記録 | 履歴（ADR-004: 操作と同じ保存の中で残す）は U3 で作るため、U1 の設定保存と週確定、U2 の確定の保証へ後から手を入れる必要がある。AC5.6.1 の「設定変更」に当たるストーリーも US1.1 の作成以外には見当たらない。U1 の保存の形が履歴を後から差し込める作りかが示されていない。 | U1 の実装メモに「履歴を後から同じ保存の中へ足せる保存の形にする」制約を加え、AC5.6.1 の「設定変更」の範囲（作成時のみか、変更操作があるか）を確認する。 | New |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/units-generation/unit-of-work.md > U4 実装メモ / U1 境界 | ADR-005 は観察者用コードを作成時に発行すると定めるが、作成を実装する U1 は参加コードと進行役用コードだけを発行し、観察者用コードの発行は U4 になる。U4 で U1 の作成処理を変更することになる。 | U1 の作成処理が 3 種類のコードを発行できる拡張点を持つ旨を明記するか、観察者用コードの発行を U1 に含める。 | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/units-generation/unit-of-work.md > U5 使う部品 | U5 の「使う部品」に AccessControl がないが、部品との対応表では U5 の AccessControl が「結果の取得の権限」とされ、components.md でも AccessControl が Reporting の呼び出し元になっている。 | U5 の「使う部品」に AccessControl（結果取得の権限の検証）を加えて表と揃える。 | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/units-generation/unit-of-work.md > Unit 一覧 / U1, U6 | チームの方針（main 反映での staging 自動デプロイ、beer-game3 専用の CI と AWS 環境、formatter・linter・type-check の CI 実行）を担う Unit がない。U6 の「CI で動かす仕組み」は非機能の検証用に限られ、U1 のウォーキングスケルトンの検証（実際に動くことの確認）に必要な CI と staging の土台も U1 の境界に書かれていない。 | U1 の境界か実装メモに、アプリケーションの雛形、CI（formatter・linter・type-check・テスト）、staging へのデプロイをどの段階で整えるかを書く。後続の工程（Delivery Planning や運用の工程）で扱うなら、その旨を明記する。 | New |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/units-generation/unit-of-work-dependency.md > 先頭の Unit の動かし方 | 「`bolt-plan.md` の印だけで実行の順序は変わらない」という、まだ存在しない成果物への言及と、「この依存の図が、実行の順序の基準になります」という記述がある。依存は位相だけを定めるという冒頭の方針と、Delivery Planning が順序を決めるという分担から外れて読める。 | 当該文を削るか、「順序の制約は依存の図が与え、順序の選択は Delivery Planning が行う」という表現に直す。 | New |

### 確認できた点

- yaml の依存ブロックは構文が正しく、6 Unit の depends_on は mermaid の図と本文の依存表に一致する。U1 を根とし、U2、U3、U4 → U1、U5 → U3、U6 → 全 Unit で循環はない。推移的に冗長な辺（U6 → U1 など）は害がない。
- 26 件の USx.y は、story map の表と traceability.json の coverage に各 1 回ずつ現れ、重複も欠落もない。Unit 別の件数（5/3/7/5/3/3）は表と一致し、すべての Unit に行がある。
- 辺の根拠は stories.md の依存と整合している（US1.6 → US1.1、US2.4 と US5.2 → US1.5、US2.5 と US2.6 → US1.3、US5.1 → US2.5 など）。
- DAG は位相だけで、推奨ビルド順やクリティカルパスはない。Unit 内の実装順は Unit 内の依存順として示され、Unit 間の順は Delivery Planning に委ねられている。
- 部品の使い方と所有は components.md に整合し、ADR-001、002、003、006 の境界を破る割り当てはない。

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| 手作業の検査（yaml と mermaid の突合、26 件の件数・重複の確認） | PASS | 依存の定義は整合し、ストーリーの割り当てに欠落も重複もない。 |

### Summary

Unit の分割と DAG は整合し、26 件のストーリーも漏れなく割り当てられていて、実装の入口として使えます。承認前に確認したいのは、参加者を識別する token の置き場所（U1 と U4 と U3 にまたがる）と、U5 の削除が U4 の実体を含むことの 2 点です。
