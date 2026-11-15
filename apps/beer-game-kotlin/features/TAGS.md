# タグの一覧と意味

フィーチャーファイル（日本語 Gherkin、先頭に `# language: ja`）のタグの一覧です。正本は [ADR-012](../../../docs/adr/beer-game-kotlin/012-gherkin-and-cucumber.md) と [テスト戦略](../../../docs/design/beer-game-kotlin/test-strategy.md)。ストーリーとの対応は、タグから自動で抽出します。

## 配置

- `features/<機能領域>/*.feature`。領域は [ユーザーストーリー](../../../docs/requirements/beer-game2/user_story.md) の Epic に合わせる。
  - `game-setup/` : Epic 1 ゲーム準備と参加（US1.1、US1.2）
  - `weekly-play/` : Epic 2 1 週の意思決定（US2.1〜US2.3）
  - `continuation/` : Epic 3 継続と復旧（US3.1、US3.2）
  - `operations/` : Epic 6 運用と観測性（US6.1）
- 2 つの処理系（Cucumber-JVM の `app/`、Cucumber-JS の `web/`）が、この 1 か所を参照する。

## ストーリー・受入条件の ID

| タグ | 意味 |
| :--- | :--- |
| `@US<番号>` | ユーザーストーリー（例: `@US2.3`）。機能（Feature）の行に付ける |
| `@AC<番号>` | 受入条件（例: `@AC2.3.1`）。シナリオに付ける。**シナリオの期待値は、受入条件の原文と意味が一致していること**。設計書由来の補足や原文との解釈の差は、シナリオの直前にコメントで書く |

## 層

1 つのシナリオは、1 つの層だけで実行する。

| タグ | 意味 | 処理系 |
| :--- | :--- | :--- |
| `@api` | アプリケーション・HTTP・永続化を通す（画面なし） | Cucumber-JVM（`./gradlew :app:acceptanceTest`） |
| `@ui` | 画面を通す（実 Ktor サーバー + ブラウザ） | Cucumber-JS + Playwright（`web/` の `npm run acceptance`） |

## 重要度

| タグ | 意味 |
| :--- | :--- |
| `@acceptance-criteria` | ユーザーストーリーの受入条件に直接対応するシナリオ |
| `@happy-path` | 正常系 |
| `@negative` | 否定・拒否・異常系 |
| `@core` | 外すとゲームの成立を失う最重要のシナリオ |

## 一時的なタグ

| タグ | 意味 |
| :--- | :--- |
| `@wip` | 作業中。完了時に必ず削除する（実行から除外する運用はしない） |

## ステップ定義とのルール

- Undefined（未定義）と Pending（未実装）のステップがあれば失敗する。
- 語彙は業務の言葉（ユビキタス言語）。イベント名・テーブル名などの実装の言葉を使わない。
- ステップ定義は薄く保ち、業務ロジックを持たない。
