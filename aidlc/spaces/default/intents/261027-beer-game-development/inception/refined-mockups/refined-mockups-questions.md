# Refined Mockups Questions

## Q1. [UX 方針] プレイ画面の情報密度

参加者が 12 ステップを進める主画面では、在庫・受注残・入荷・当週受注・意思決定入力をどのように配置しますか？

- A. 主要値と当ステップの操作を 1 画面にまとめ、履歴や説明は展開式にする
- B. ステップごとに画面を切り替える wizard 形式にする
- C. dashboard に全情報と全操作を常時表示する
- X. Other (please specify)

[Answer]: A. 主要値と当ステップの操作を 1 画面にまとめ、履歴や説明は展開式にする

## Q2. [操作安全性] 週確定の確認方法

4 役割の入力が揃った後、進行役が週を確定する際の誤操作防止をどうしますか？

- A. 役割別の入力完了一覧と結果影響の要約を示す確認 dialog を使う
- B. 確定 button の長押しまたは二段階操作を使う
- C. 確認なしで確定し、直後だけ undo を許可する
- X. Other (please specify)

[Answer]: A. 役割別の入力完了一覧と結果影響の要約を示す確認 dialog を使う

## Q3. [Responsive] 初回リリースの画面幅

要件では desktop browser が対象で、mobile 専用 application は対象外です。responsive 対応範囲をどうしますか？

- A. 1024 px 以上を主対象とし、狭い幅では閲覧可能だが操作開始を案内する
- B. 768 px 以上の tablet 横向きまで全操作を対応する
- C. 320 px 以上の smartphone 幅でも全操作を対応する
- X. Other (please specify)

[Answer]: A. 1024 px 以上を主対象とし、狭い幅では閲覧可能だが操作開始を案内する

## Established constraints

- WCAG 2.2 AA を基準とし、keyboard 操作、色以外の状態表現、明確な focus 表示を必須とする。
- 既存の application design system はないため、semantic token と native HTML を優先した最小 component set を定義する。
- loading、empty、error、success、stale、paused、ended、reconnecting の各状態を主要画面で扱う。

## Assumptions & Open Questions

- 観察画面と export は Should Have とし、walking skeleton の主画面より後に実装可能な独立 flow とする。
- classic scope では rough mockups が存在しないため、承認済み user stories と requirements から直接 refined mockups を作成する。
