---
type: Reference
title: "Unit U1 人のゲート確認手順（B1〜B3、Kotlin 版）"
description: "beer-game-kotlin の Unit U1（B1〜B3）の人のゲートを、ユーザーが確認するための手順。再現コマンドとその期待結果、ゲートごとの確認表（見るファイル・再現・判断）、人の判断が要る項目と推奨、AWS 適用前の確認、承認の記録の依頼例。"
tags: [report, plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-15T00:34:20Z }
---

# Unit U1 人のゲート確認手順（B1〜B3、Kotlin 版）

この資料は、U1 のゲートを**ユーザーが自分で確認する**ための手順です。各ゲートで、何を見て・どう再現して・何を判断するかを順に示します。チェック欄はすべて空です。**この資料は承認の記録ではありません。**

## 1. 冒頭

### 1.1 承認の意味

- ゲートの承認は、**ユーザー自身がコードとテストを確認する**ことで意味を持ちます。AI が代わりに「承認済み」と記録することはありません。
- 状態の根拠は [Unit U1 総括](./unit_u1_summary.md)、[Bolt 1](./bolt_1_report.md)・[Bolt 2](./bolt_2_report.md)・[Bolt 3](./bolt_3_report.md) の終了報告です。いずれも「人の確認待ち（未承認）」と記録されています。

### 1.2 承認の記録方法

- ユーザーが指示した項目だけを、指示どおりに記録します（例文は第 6 章）。指示の無い項目は「未承認」のままにします。
- 直す判断（却下）も同じ形で記録します。理由を添えてください。ガードレールにすべきものは `CLAUDE.md`・`PROJECT.md` に反映します。

### 1.3 確認の優先順位（リスクの高いものから）

| 順 | 対象 | 理由 |
| :--- | :--- | :--- |
| 1 | B1 ゲート 6・7・8（集約、イベントストアと冪等、処理の順序） | 下流へ誤りが膨らむ。リリース計画で「高」リスク |
| 2 | B1 ゲート 4（golden と BR）、ゲート 3（シナリオと原文） | 契約。教材とのずれは後で直しにくい |
| 3 | B2 ゲート 3（権限と V101）、B1 ゲート 7（マイグレーション 001〜005） | スキーマ・権限は確認必須 |
| 4 | B3 ゲート 2・3（Terraform、デプロイ）。AWS 適用は別ゲート | 本番環境・デプロイ設定は確認必須 |
| 5 | 残りのゲート | 構成・道具・画面 |

## 2. 最初に一度だけ実行する再現コマンド

作業場所は `apps/beer-game-kotlin/` です。件数は [U1 総括](./unit_u1_summary.md) と [Bolt 3 終了報告](./bolt_3_report.md) の実測値で、**この資料の作成時には再実行していません**。

| # | 目的 | コマンド | 期待結果（報告書の実測値） |
| :--- | :--- | :--- | :--- |
| R1 | 全体のビルドとテスト（所要は約 6〜7 分） | `cd apps/beer-game-kotlin && export JAVA_HOME=$(/usr/libexec/java_home -v 25) && ./gradlew build integrationTest acceptanceTest acceptanceTestH2 koverVerify` | BUILD SUCCESSFUL。Kotlin 側 586 件・失敗 0（domain 201、application 86、adapter-persistence 46 + 統合 55、adapter-http 70、app 71 + 統合 1、受け入れ `@api` は PostgreSQL と H2 の各 28 テスト）。PMD の「Found 17 violations」は fixture の期待どおり。PostgreSQL の統合は Docker が必要 |
| R2 | detekt（JDK 21 専用） | `export JAVA_HOME=$(/usr/libexec/java_home -v 21) && ./gradlew detekt` | 成功（違反 0）。JDK 25 では動かない（ユーザーの決定で JDK 21 専用ジョブ） |
| R3 | web | `cd web && npm run verify` | 成功（format・lint・typecheck・Vitest 70 件・build） |
| R4 | コンテナのスモークテスト（Docker が要る。初回ビルド約 6 分） | `./scripts/container-smoke.sh`（ビルド済みなら `SKIP_BUILD=1 RUNS=1`） | 「スモークテスト: すべて成功」。api の `/api/v1/ready`・`/api/v1/health` が 200、migrate が終了コード 0、秘密無し 78、本番相当の H2 は 78、未実装モード 69、非 root（uid 10001）、H2 無し、SIGTERM は 143。起動時間は最大 6.0 秒（ローカル） |
| R5 | Terraform の fmt と validate（**作業用の Terraform 1.17 が要る**。システムの 1.5.7 では足りない） | `cd infra && terraform fmt -check -recursive`、`cd envs/staging && terraform init -backend=false && terraform validate`（`envs/production` も同様） | fmt は差分なし、validate は両環境とも成功（Terraform 1.17.2、AWS プロバイダー 6.73.0）。`plan` は認証情報が無く未実行 |
| R6 | ローカル起動（H2。人の開発サーバーのポート 3000・5173 と避けるため 3100 を使う） | `APP_ENV=local DB_KIND=h2 PORT=3100 ./gradlew :app:run`、別の端末で `curl -s localhost:3100/api/v1/ready`、`curl -s localhost:3100/api/v1/health` | 200 が返る（CI の `ui` ジョブと同じ設定）。API の経路は `contracts/openapi.yaml` の 11 本（`/games`、`/participations/join`、`/games/{gameId}/start`、`/sessions/{sessionId}/decisions` など） |
| R7 | web の受け入れ（`@ui`、任意） | R6 を起動したまま `cd web && npm run acceptance` | `@ui` 1 シナリオが成功（Playwright。ブラウザ導入が要る場合がある。**この資料では未確認**） |

補足: `git log --oneline` の B1〜B3 のコミットは [U1 総括](./unit_u1_summary.md) 第 1 章の一覧にあります。GitHub Actions は `gh run list --workflow beer-game-kotlin.yml` で確認できます。実績は次のとおりです（2026-11-15 に、push 後の実行を確認）。初回の `907c206` は **failure**（原因は、`web` のロックファイル `package-lock.json` が、CI の Node 26 の npm で `npm ci` の整合を満たさなかったこと。ローカルの Node 24 の npm で作ったため、`@emnapi/core`・`@emnapi/runtime` が不足していた。ロックを Node 26.13.1 の npm で更新して解消）。続く `6d9625a` と `d0f36d2` は **success**（8 ジョブ: contract、test、detekt（JDK 21）、pmd、web、ui、container、n1 のすべて）。総括・各終了報告の「GitHub Actions 上は未実行」の記述は、この実行の前の状態で、古くなっています。

## 3. ゲートごとの確認表

パスは `apps/beer-game-kotlin/` からの相対です。「判断」は、承認するか、直すかです。

### 3.1 B1（計画: [bolt_1_plan](./bolt_1_plan.md)。ゲート 1〜12）

| # | 確認すること（計画の記述） | 見るファイル | 再現 | 判断 | 関連 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | H2 の実測の結果と、置き換え・省略の一覧。設計が H2 で成り立つか | `../../docs/design/beer-game-kotlin/data-model.md`（ローカル開発の方言の差分 29 項目）、`adapter-persistence/src/test/kotlin/beergame/persistence/H2PersistenceSpec.kt`、[ADR-014](../../adr/beer-game-kotlin/014-h2-for-local-development.md) | R1（H2 テスト 46 件） | H2 でのローカル構成を承認するか | B1 #12 |
| 2 | 構成、依存関係の導入の承認の記録、モジュールの依存の検査 | `settings.gradle.kts`、`gradle/libs.versions.toml`、各層の `build.gradle.kts`、各層の `DependencyDirectionSpec.kt`（domain を除く 3 層）、`domain/src/test/.../ToolchainSpec.kt` | R1 | 導入した依存（junit-bom ほか）の承認の範囲 | B1 #13、総括 #14 |
| 3 | シナリオ（業務の言葉）と仕様を契約として承認。**タグの一致ではなく、期待値が受入条件の原文と一致**。AC1.2.5 の原文との差、AC2.3.3・AC6.1.2 を Gherkin にしない判断 | `features/**/*.feature`（7 ファイル）、`features/TAGS.md`、`contracts/openapi.yaml`、原文は `../../docs/requirements/` 配下の受入条件（パスは未確認。計画の Step 3 の表を参照） | R1（`acceptanceTest` 27 シナリオ） | シナリオごとに原文と照合し、契約として承認するか。AC1.2.5 の解釈（拒否か付け替えか） | B1 #2、総括 #13 |
| 4 | golden の期待値が BR-02〜BR-09 と一致。ドメインに `var`・可変コレクション・`!!`・`throw` が無い | `domain/src/main/kotlin/beergame/domain/SimulateWeek.kt`、`Quantities.kt`、`Values.kt`、`domain/src/test/.../SimulateWeekGoldenSpec.kt`、`SimulateWeekPropertySpec.kt` | `./gradlew :domain:test`、`grep -rnE '\bvar\b|!!|throw ' domain/src/main` | 期待値の手計算（5 系列。各テストのコメントに途中計算）が BR と一致するか | 計画 Step 4 の結果 |
| 5 | ルールが `decide` に集まり、`evolve` が計算をしていない | `domain/.../Game.kt`、`Session.kt`、`StartGame.kt`、テスト `GameDecideSpec.kt`、`GameEvolveSpec.kt`、`SessionDecideSpec.kt`、`SessionEvolveSpec.kt` | `./gradlew :domain:test` | 下の 3.4 の観点で全行を読んだうえで承認するか | — |
| 6 | 集約の粒度と `startGame` の原子性（仮説 1）。誤りなら止めて設計を見直す | `domain/.../StartGame.kt`、`GameFlowSpec.kt`、`StartGameSpec.kt`、`../../docs/design/beer-game-kotlin/domain-model.md` | `./gradlew :domain:test` | Game・Session の分け方を承認するか | B1 #3〜#11 |
| 7 | 版・冪等・原子性のテストと、ポートの契約テストが両実装で緑。**マイグレーション 001〜005 を承認** | `adapter-persistence/src/main/resources/db/migration/common/V001〜V005*.sql`、`JdbcEventStore.kt`、`JdbcIdempotencyStore.kt`、`JdbcTransactionRunner.kt`、`src/test/.../PortContracts.kt`、`EventStoreContract.kt`、`IdempotencyContract.kt`、`ProjectionContract.kt`、`H2PersistenceSpec.kt`、`src/integrationTest/.../PostgresPersistenceSpec.kt` | R1 | スキーマ（確認必須）を承認するか。V101 と V102 の順序（後述 #7） | B1 #12、B2 #6 |
| 8 | 処理の順序（[ADR-004](../../adr/beer-game-kotlin/004-idempotency-after-authorization.md)）と、業務ルールが関数の束に漏れていないこと | `application/src/main/kotlin/beergame/application/Execute.kt`、`Commands.kt`、`Credentials.kt`、`IdempotencyDigest.kt`、`ExecuteSpec.kt`、`GameCommandsSpec.kt`、`SessionCommandsSpec.kt` | `./gradlew :application:test` | 認可 → 冪等 → 実行の順序を承認するか（3.4 の観点） | — |
| 9 | 仕様と実装が手で照合できる範囲で一致（契約テストは B2）、ログの内容、H2 の拒否 | `adapter-http/src/main/kotlin/beergame/http/` 配下、`contracts/openapi.yaml`、`app/src/main/kotlin/beergame/app/AppConfig.kt`、`LogRecord.kt` | R1、R6 | HTTP 層とログを承認するか | B1 #1（参加の応答に `gameId` が無い） |
| 10 | 画面が API の仕様と型に従う | `web/src/api/client.ts`、`web/src/api/generated/schema.d.ts`、`web/src/features/*/`、`web/steps/walking-skeleton.steps.mjs`、`features/weekly-play/walking-skeleton-ui.feature` | R3、R6、R7 | 画面を承認するか。人による実操作（ローカル H2 で 1 ゲーム）の申告 | 総括 第 4 章「デモ項目」 |
| 11 | シナリオが業務の言葉のまま green | `app/src/acceptanceTest/kotlin/beergame/acceptance/*.kt`、`features/` | R1（`acceptanceTest`・`acceptanceTestH2`） | シナリオの green を承認するか。AC1.2.5 の通知（`moved`）の要否 | 計画 Step 11 の結果 |
| 12 | Bolt の承認（完了条件の確認） | [bolt_1_report](./bolt_1_report.md) の完了条件の表 | R1〜R3 | B1 全体を承認するか。**domain の行 100% は追補で到達（R1 の `koverVerify` が 100% のゲート）** | B1 #14 |

### 3.2 B2（計画: [bolt_2_plan](./bolt_2_plan.md)。ゲート 1〜6）

| # | 確認すること | 見るファイル | 再現 | 判断 | 関連 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | PMD のルールと fixture、**層ごとの緩和** | `config/pmd/fp-kotlin-rules.xml`、`ruleset-main.xml`、`ruleset-adapter.xml`、`ruleset-domain.xml`、`ruleset-test.xml`、`config/pmd/fixtures/Fixture.kt`、`expected.txt`、[ADR-011](../../adr/beer-game-kotlin/011-strict-static-analysis.md) | `./gradlew pmdFixtureTest pmdDomainApplication pmdAdapter pmdMain pmdTest`（ルートの `build.gradle.kts` に定義。違反 0、fixture 17 件一致が期待） | 緩和の粗さ（外したルールは、その層の新規違反を検出しない）を許容するか。ADR を承認するか | B2 #3〜#5 |
| 2 | Kover の実測とゲートの設定 | `build.gradle.kts`、`domain/build.gradle.kts`（行 100%）、`app/build.gradle.kts` | `./gradlew koverVerify`（全体は行 85%・分岐 75%。B2 の実測は 96.8%・78.1%） | domain の行 100% のゲートと `-jvm-default=no-compatibility` を承認するか（除外・引き下げなし）。分岐の余裕 3.1 ポイント | B2 #1、#18 |
| 3 | **権限の設計とマイグレーション** | `adapter-persistence/src/main/resources/db/migration/postgres/V101__database_roles.sql`、`V102__idempotency_create_unique_index.sql`、`src/integrationTest/.../RolePrivilegesSpec.kt`、`../../docs/design/beer-game-kotlin/data-model.md` | `./gradlew :adapter-persistence:integrationTest`（Docker。11 件の否定テスト。連鎖削除が `events` に DELETE 権限の無いロールで動く） | V101 の GRANT と、「否定テストが何を保証し何を保証しないか」（3.4）を承認するか。V101 < V102 の順序 | B2 #6、#17 |
| 4 | CI の構成 | `.github/workflows/beer-game-kotlin.yml`（`contract`・`test`・`detekt`・`pmd`・`web`・`ui`・`n1`・`container` の 8 ジョブ） | `gh run list --workflow beer-game-kotlin.yml` | ジョブ構成と、`actions` の SHA 固定を承認するか。N-1 は雛形 | B2 #12、#13 |
| 5 | 契約テストの道具の実装（選定・導入は 2026-11-14 に承認済み） | `contracts/openapi.yaml`、`contracts/redocly.yaml`、`app/src/test/kotlin/beergame/app/contract/*.kt`、`web/scripts/check-generated.mjs`、`web/src/api/generated/schema.d.ts` | `cd web && npm run api:lint && npm run api:check`、`./gradlew :app:test`（契約テスト 13 件） | 実装と、仕様の後追い修正 7 件、置き場（指示は `adapter-http`、実装は `app`）を承認するか | B2 #2、#10 |
| 6 | Bolt の承認 | [bolt_2_report](./bolt_2_report.md) | R1〜R3 | B2 全体と「B3 以降を止めるか」の判定（リリース計画）。domain 100% は追補で到達済み | B2 #14 |

### 3.3 B3（計画: [bolt_3_plan](./bolt_3_plan.md)。ゲート 1〜4）

報告書は「ゲート 1〜4・5」と書きますが、**計画に定義されているのはゲート 1〜4 です**（ゲート 5 の定義は計画に見つからず、**未確認**）。ゲート 4 を Bolt の承認として扱ってください。**いずれも AWS には触れません。**

| # | 確認すること | 見るファイル | 再現 | 判断 | 関連 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | コンテナと起動モード | `Dockerfile`、`.dockerignore`、`scripts/container-smoke.sh`、`app/src/main/kotlin/beergame/app/Main.kt`、`MainSpec.kt`、`app/build.gradle.kts`（配布から H2 を除外）、[container_local](../../operation/beer-game-kotlin/container_local.md) | R4 | `ENTRYPOINT` と `CMD` の形、SIGTERM の終了コード 143、終了コード体系（64・69・70・78）を承認するか | B3 #1、#12、#13、#24 |
| 2 | **Terraform の定義（本番環境・デプロイ設定は確認必須）** | `infra/envs/{staging,production}/main.tf`、`variables.tf`、`versions.tf`、`infra/modules/{network,rds,ecr,secrets,alb,web,ecs,github_oidc}/main.tf` | R5 | 設計との差 4 点（ECS は公開サブネット、KMS 無し、本番はローリング、DB ログインロール分離無し）を承認するか。`plan` の扱い | B3 #2〜#6、#8 |
| 3 | **デプロイ・ロールバックの定義（確認必須）** | `.github/workflows/beer-game-kotlin-deploy-staging.yml`、`-deploy-production.yml`、`-rollback-staging.yml`、`-rollback-production.yml`（すべて `workflow_dispatch` のみ）、[deploy](../../operation/beer-game-kotlin/deploy.md)、[rollback](../../operation/beer-game-kotlin/rollback.md) | `grep -n "^on:" -A4 .github/workflows/beer-game-kotlin-*.yml`（`push` が無いこと） | IAM とワークフローの突合（未実施）、業務のスモークテスト（未実装）、履歴を S3 `deployments/` に置く設計 | B3 #7、#9〜#11、#20 |
| 4 | Bolt の承認（B3 全体と全行理解） | [bolt_3_report](./bolt_3_report.md) | R1〜R5 | B3 を承認するか。AWS への適用の判断は**別ゲート**（第 5 章） | B3 #23 |

### 3.4 コードの全行理解を要するゲートの観点

**読む順序の目安**: domain → persistence → application → adapter-http → app → web。層ごとに、テストを先に読んでからコードを読みます。

| 観点 | 見る場所 | 何を確かめるか |
| :--- | :--- | :--- |
| `decide`・`evolve` の全域性 | `domain/.../Game.kt`、`Session.kt` と各 `*DecideSpec`・`*EvolveSpec` | すべての（状態 × コマンド／イベント）の組が、`when` の `else` なしで網羅されているか。`evolve` が計算せず、イベントの内容を畳むだけか。`InvalidTransition` の性質テストは**未実施**（B2 #20） |
| 冪等と認可の順序 | `application/.../Execute.kt`、`IdempotencyDigest.kt`、`ExecuteSpec.kt`、[ADR-004](../../adr/beer-game-kotlin/004-idempotency-after-authorization.md) | 順序が「認可 → 冪等の照合 → 実行」であり、失効した旧担当者が以前に成功した識別子を再送しても 403 になるか（認可が先） |
| 版と原子性 | `JdbcEventStore.kt`、`JdbcTransactionRunner.kt`、各 `*Contract.kt` | 版の不一致で追記が失敗するか。投影の更新が同一トランザクションか。両実装（H2・PostgreSQL）で同じ契約を通るか |
| 権限の否定テストの意味 | `RolePrivilegesSpec.kt`、`V101__database_roles.sql` | 「書き込みロールが `events` を UPDATE・DELETE・TRUNCATE できない」等を**実際に拒否されることで**確かめているか（変異で 6 件が失敗した記録がある）。**保証しないこと**: アプリが用途別ロールの接続を使うこと（アプリは単一の接続ユーザーのまま。B3 #5、B2 #17） |
| PMD の層単位の緩和 | `config/pmd/ruleset-*.xml`、`fp-kotlin-rules.xml` | 外したルールの一覧と理由（ADR-011）。層全体で外すと、その層の新しい違反を検出しない |
| 例外・抑制の不在 | `grep -rn "@Suppress" apps/beer-game-kotlin --include=*.kt`、`grep -rn "baseline"` | 実使用 0（B1 で AI の「無い」の報告が誤りだった記録があるため、**自分で実行する**） |

## 4. 人の判断が要る項目（[総括](./unit_u1_summary.md) 第 5 章の統合一覧から）

### 4.1 決める順序

#1 → #2 → #3 → #7 → #4 → #5 → #8〜#17 → #18〜#24。#1（U1 のゲートを検証するか）が、以降の Bolt のゲート密度を決めます。

### 4.2 優先度 A（次の Bolt の着手と、結果の受け入れを左右する）

| # | 項目 | 選択肢 | AI の推奨（事実に基づく） |
| :--- | :--- | :--- | :--- |
| 1 | U1 の承認 | (a) 本資料で B1〜B3 を検証する (b) 一部だけ検証し、残りは B4 の前に回す | (a)。人の検証が無く、AI の出力の質の実績が取れていない（B1 仮説 5 は判断不能）。B1 では AI の自己申告の誤りが 1 件あった |
| 2 | B2 の判定（B3 以降を止めるか） | (a) 続行を承認 (b) 止めて直す | 事実: detekt（JDK 21）・PMD・Kover・連鎖削除は機能。未達だった domain の行 100% は追補で到達。(a) の根拠はあるが、判定は人 |
| 3 | domain の行 100% のゲート | (a) 100% を承認 (b) 97% に戻し設計書を直す | (a)。除外・引き下げなしで到達。`-jvm-default=no-compatibility` が副作用を持たないか、コンパイラ設定を `domain/build.gradle.kts` で確認してください |
| 4 | `terraform plan` の受入条件 | (a) 受入条件の文言を「`validate` まで」に直す (b) AWS の認証情報で `plan` を実行する | 判断材料: `validate` はデータソースの解決・名前の長さ・`postgres18` ファミリーの受理を確認しない（B3 #25）。AWS 適用を目指すなら (b)。適用しない間は (a) で Release 0.1 の記述を正直にする |
| 5 | GitHub Actions 上の実行 | (a) 実行結果を確認して根拠に使う (b) 不要 | (a)。`gh run list` で、直近 2 回（`6d9625a`・`d0f36d2`）の 8 ジョブすべての success を確認済み。初回の failure（`907c206`）は、`npm ci` のロックファイル不整合で、解消済み。`n1` は雛形（直前のリリースのタグが無い間は実行しない）で、本実装は未 |
| 6 | AWS への適用 | 別ゲート（第 5 章） | 本資料の範囲外 |
| 7 | マイグレーション 001〜005 と V102 の承認、V101 と V102 の順序 | (a) 永続環境の前に Flyway の `outOfOrder` を許す (b) 番号を付け替える | 永続の環境がまだ無いので、ステージング適用の前に決めれば足りる。どちらかは設計判断（人） |

### 4.3 優先度 B・C

#8〜#17（設計との差、SIGTERM の終了コード、PMD 緩和、仕様の後追い 7 件、参加応答の `gameId`、B1 の仕様の未決、追加依存、ADR の要否、契約テストの置き場、B3 の承認項目）と #18〜#24（持ち越し、実測）は、[総括 第 5 章](./unit_u1_summary.md) の表と、各終了報告の番号で選択肢を確認してください。

- **B4 の前に決める**: #12（参加の応答に `gameId` が無く、参加者の画面が止まる。応答に足すにはバックエンドと仕様の変更が要る）。
- **SIGTERM（#9）**: 実測は 143。設計を 143 に合わせる案と、アプリで 0 にする案がある。ECS の停止では問題にならない想定で、終了コードをアラーム条件にする場合のみ影響する（B3 #1）。

## 5. AWS 適用の前に確認すること

AWS への適用は、**本資料の範囲外の別ゲート**です（`terraform apply`・デプロイ・OIDC・状態用 S3 の作成を含み、いずれも未実施）。確認項目の全体は [Bolt 3 終了報告「AWS への適用前に人が確認すべき項目」](./bolt_3_report.md) にあります。要点は次のとおりです。

- **費用**: Multi-AZ の RDS（`db.t4g.small`）、Fargate（本番 2〜4 タスク、各 1 vCPU / 2 GiB）、ALB、CloudFront、Secrets Manager 4 本ほか。月額の概算は**未実施**。beer-game2 でリリースが止まった原因（R10）と同じ。
- **アカウントと GitHub 側**: 環境ごとのアカウント分離、OIDC プロバイダーの有無、状態用の S3、GitHub Environment（`production` は必須レビュアー）と変数一覧。
- **IAM とセキュリティ**: デプロイロールとワークフローの突合（未実施）、公開サブネットの判断、秘密が Terraform の状態に入る点。
- **手順の不足**: ECR を先に作る適用順（手順書に無い）。適用前は、デプロイのワークフローの `push` トリガーを有効にしません。

## 6. 承認の記録の依頼の例文

記録は、**ユーザーが指示した範囲だけ**を、指示された状態（承認・却下・保留）で行います。範囲外は「未承認」のままです。

| 依頼の例 | 記録される範囲 |
| :--- | :--- |
| 「B1 のゲート 1〜12 を承認して記録して」 | `bolt_1_plan.md` と `bolt_1_report.md` と `index.md` のゲート 1〜12 の状態のみ。B2・B3 は変えない |
| 「B1 のゲート 6 と 7 だけ承認。ゲート 3 は AC1.2.5 の解釈を直す必要があるので保留として記録して」 | ゲート 6・7 は承認、ゲート 3 は保留と理由。他は未承認のまま |
| 「判断項目 #3 は承認（domain 100%）、#4 は (a) で。記録して」 | 総括の #3・#4 のみ。選択した案を明記 |
| 「B3 のゲート 2 は却下。ECS をプライベートサブネットにする方向で直して」 | ゲート 2 を却下と記録し、修正の作業項目を計画に追加 |

**記録してはならないもの**: ユーザーが言っていないゲートの承認、「コードの全行理解」の承認（ユーザーが明示した場合のみ）、AWS 適用の判断（別ゲート）。

## 確認チェックの一覧（すべて未実施）

- [ ] R1 全体のビルドとテスト　- [ ] R2 detekt　- [ ] R3 web　- [ ] R4 コンテナのスモークテスト　- [ ] R5 Terraform　- [ ] R6 ローカル起動
- [ ] B1 ゲート 1〜12（各行の判断欄）　- [ ] B2 ゲート 1〜6　- [ ] B3 ゲート 1〜4
- [ ] 第 4 章の優先度 A #1〜#7 の判断　- [ ] 承認の記録の依頼（第 6 章）
