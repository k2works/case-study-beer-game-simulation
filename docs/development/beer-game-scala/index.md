# beer-game-scala — 開発

beer-game-scala プロジェクトの開発ドキュメントです。

## ドキュメント一覧

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [リリース計画](./release_plan.md) | Intent、Bolt 計画（B1〜B15、予備 B16）、Release 0.1 / 0.2 / 1.0、価値指標、リスク台帳 | 草案（人の承認待ち） |
| [開発戦略](./development_strategy.md) | 序盤（アウトサイドイン）・中盤（インサイドアウト）・終盤（アウトサイドイン）の局面、BDD、Living Documentation、静的解析 | 草案（人の承認待ち） |
| [Bolt 1 計画](./bolt_1_plan.md) | 基盤・静的解析・縦の最小（ウォーキングスケルトン）のステップ計画、着手前の判断項目、依存関係の一覧 | 草案（人の承認待ち） |
| [Bolt 1 終了報告](./bolt_1_report.md) | B1 の完了条件の達成状況、仮説の検証、簡略化、人の判断が要る項目、Living Documentation の実施結果 | 草案（実装完了・ゲート未承認） |
| [Bolt 2 終了報告](./bolt_2_report.md) | CI・テスト基盤。OpenAPI 契約テストとプロジェクトごとのしきい値は未了 | 草案（一部完了） |
| [Bolt 3 終了報告](./bolt_3_report.md) | 入力と週確定の完成・観測（Release 0.1 相当）。許可リスト 100%・AC2.3.1 が緑 | 草案（実装完了・ゲート未承認） |
| [Bolt 4 終了報告](./bolt_4_report.md) | 進行の継続と資格（停止・再開・代理入力、復帰、失効・再発行、鍵のローテーション、役割の入れ替え、試行の窓） | 草案（実装完了・ゲート未承認） |
| [Bolt 5 終了報告](./bolt_5_report.md) | 共同担当と共同入力（競合の応答、並行の保存）。U2 完了 | 草案（実装完了・ゲート未承認） |

## 前提

- 設計: [beer-game-scala の設計](../../design/beer-game-scala/index.md)、[ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md)（提案中）
- 計画の範囲は U1〜U6（Release 1.0）です。設計書・ADR-001 は「U1〜U3 を約束」のままで、計画の承認後に更新します。
