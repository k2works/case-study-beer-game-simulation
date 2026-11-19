# Business Overview

## 目的とドメイン

このリポジトリは、日本システム・ダイナミクス学会（JSD）の改訂版ビールゲームを、複数人で遊べるデジタルシミュレーションとして再現するケーススタディです。第一の目的は勝敗ではなく、情報遅延と配送遅延のもとで在庫と受注残の振動が増幅する過程（Bullwhip Effect）を体験し、構造が行動を生むことを学ぶことです（`docs/requirements/beer-game/requirements_definition.md`）。

## 主なアクターと機能

- アクター: 参加者（工場・一次卸・二次卸・小売店の 4 役割）、進行役、観察者。
- 機能: ゲーム作成、参加コードでの参加、役割割当て、12 ステップの週次進行、発注・生産要請の入力、在庫・受注残・費用の自動計算、一時停止・再開・終了、中断からの復元、結果の可視化と出力、保持期限後の削除。
- 規則: 配送・注文・生産の遅延は各 2 週、費用は在庫 0.50 ドル・受注残 1.00 ドル、初期値は各段 4、各役割の在庫 12（BR-01〜BR-14）。

## リポジトリの現状

| 領域 | 現状 |
| :--- | :--- |
| `apps/beer-game2/` | v2 の実装。ports and adapters、Fastify API、React UI、PostgreSQL、Terraform（AWS）まで揃う。 |
| `apps/beer-game/` | v1 の実装。v2 の README が「参照用に残している」と記す。 |
| `apps/beer-game3/` | 存在しない。本 Intent（261111-beer-game3-setup）で新規に立てる対象。 |
| `docs/` | プロジェクト別（beer-game、beer-game2）の要件・設計・ADR・開発・運用・レビュー・ジャーナル。 |
| `ops/`、ルートの Gulp | MkDocs、マニュアル、ジャーナル、vault、SSH、SonarQube、OKF の運用タスク。 |

## 要件の版の違い

対象の要件（`docs/requirements/beer-game/requirements_definition.md`）は FR-01〜FR-15、NFR-01〜NFR-10、BR-01〜BR-14、UC-01〜UC-15、ASM-01〜ASM-05。beer-game2 の要件は、これに FR-16（共同入力）、FR-17（観察者）、FR-18（自動確定）、NFR-11（観測性）、NFR-12（運用性）、BR-15〜BR-17 を加え、FR-01 に週数 1〜50 の記述がある。

## 未確定事項

次は調査では決められず、確定事実ではありません。要件定義・設計の段階で人が決める必要があります。

1. beer-game3 の範囲: v1 の要件だけか、v2 の追加分（FR-16〜FR-18、NFR-11・NFR-12）を含むか。
2. 土台にするコード: v1（`apps/beer-game`）か v2（`apps/beer-game2`）か、あるいは新規か。v2 は構成と規約が整っており再利用候補だが、決定ではない。
3. ASM-01: 既定の顧客需要系列が未確定。`project.md` の方針は、JSD 既定が未確定の間はカスタム系列で技術検証を先行し、JSD 準拠の受入判定は保留する。
4. 技術の版: Node（v2 は 26、v1 の CI は 22）と PostgreSQL（v2 は 18、v1 の CI は 16）をどれにするか。
5. docs の登録: `docs/requirements/beer-game3/` ほかの追加と、`docs/requirements/index.md`、`docs/index.md`、`mkdocs.yml` の更新（`apply-docs-structure` の add-project）。
