# Practices Discovery Questions

## Q1. [開発チーム] branch と merge の進め方

Git には `main` と `develop` がありますが、履歴だけでは今後の運用を確定できません。どの進め方を採用しますか？

- A. `main` を trunk とし、短命 branch を PR で squash merge する
- B. `develop` に統合し、リリース時に `main` へ merge する
- C. 原則 `main` へ直接 commit し、大きな変更のみ PR を使う
- X. Other (please specify)

[Answer]: B. `develop` に統合し、リリース時に `main` へ merge する

## Q2. [開発チーム] 最初に薄い end-to-end slice を作るか

最初に「1 ゲームを作成し、4 役割の入力から 1 週分を確定して状態を表示する」最小版を作りますか？ Walking skeleton とは、実際の機能を広げる前に、各部品が端から端まで接続できることを証明する最小の実行可能版です。

- A. はい、この最小版を最初に完成させる
- B. いいえ、ドメイン・UI・基盤を個別に作ってから統合する
- X. Other (please specify)

[Answer]: A. はい、この最小版を最初に完成させる

## Q3. [品質保証] テストの方法と実装順序

週次計算、週確定の冪等性、役割別認可、復元の回帰を防ぐため、どのテスト姿勢を採用しますか？

- A. TDD：失敗する test を先に書き、最小実装で通して refactor する
- B. BDD：Given/When/Then の振る舞い例を先に定義して実装する
- C. test-after：実装後に各層のテストを追加する
- X. Other (please specify)

[Answer]: B. BDD：Given/When/Then の振る舞い例を先に定義して実装する

## Q4. [リリース運用] application の deployment 方針

文書は `main` merge 後に自動公開されますが、ゲーム本体の環境運用は未確定です。どの方針にしますか？

- A. `main` merge 後に staging へ自動反映し、production は手動承認後に deploy する
- B. staging と production のどちらも手動 deploy する
- C. 現在は deployment 自動化を定めず、ローカル実行のみを対象とする
- X. Other (please specify)

[Answer]: A. `main` merge 後に staging へ自動反映し、production は手動承認後に deploy する

## Q5. [開発チーム] code style と自動チェック

現状は Node.js ESM と camelCase を使っていますが、ESLint、Prettier、type-check は未設定です。今後の application code にどこまで強制しますか？

- A. formatter、linter、type-check を導入し、CI 失敗時は merge しない
- B. formatter と linter を導入し、type-check は技術選定後に決める
- C. 現時点では自動強制せず、実装者の判断に委ねる
- X. Other (please specify)

[Answer]: A. formatter、linter、type-check を導入し、CI 失敗時は merge しない
