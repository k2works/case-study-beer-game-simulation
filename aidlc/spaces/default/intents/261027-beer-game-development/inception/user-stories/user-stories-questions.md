# User Stories Questions

## Q1. [プロダクト所有者] persona の分け方

4 つの supply-chain 役割は、入力と参照で共通点が多い一方、工場だけが生産要請を行います。persona をどの粒度で定義しますか？

- A. 進行役、supply-chain 参加者、観察者の 3 persona とし、工場差分は story で表す
- B. 進行役、工場、一次卸、二次卸、小売店、観察者の 6 persona に分ける
- C. 進行役、生産役、流通役、観察者の 4 persona とする
- X. Other (please specify)

[Answer]: C. 進行役、生産役、流通役、観察者の 4 persona とする

## Q2. [プロダクト所有者] story の分解軸

walking skeleton を最初に完成させるため、story をどの軸で分解しますか？

- A. ゲーム準備 → 参加 → 1 週プレイ → 継続・復旧 → 振り返りの workflow 順
- B. 進行役、参加者、観察者の persona ごと
- C. setup、domain calculation、persistence、UI、analysis の技術領域ごと
- X. Other (please specify)

[Answer]: A. ゲーム準備 → 参加 → 1 週プレイ → 継続・復旧 → 振り返りの workflow 順

## Q3. [プロダクト所有者] MVP 上の優先順位

観察ビューと CSV / JSON export は要件に含まれますが、walking skeleton の完成には直接必要ありません。初回リリースでの優先度をどうしますか？

- A. 観察ビューと export の両方を Should Have とする
- B. 観察ビューを Should Have、export を Could Have とする
- C. 両方を Must Have とする
- X. Other (please specify)

[Answer]: A. 観察ビューと export の両方を Should Have とする
