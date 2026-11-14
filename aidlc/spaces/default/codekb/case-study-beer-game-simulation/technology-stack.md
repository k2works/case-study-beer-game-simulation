# Technology Stack

## beer-game2（`apps/beer-game2/package.json`。版は固定）

| 区分 | 技術 | 版 |
| :--- | :--- | :--- |
| 実行環境 | Node.js | 26（`engines >=26`、`.nvmrc` 26） |
| 言語 | TypeScript | 6.0.3（strict、noUncheckedIndexedAccess、NodeNext） |
| Web | Fastify / @fastify/cookie | 5.12.8 / 11.1.5 |
| DB | PostgreSQL / pg / node-pg-migrate | 18（compose）/ 8.23.1 / 9.0.0 |
| 検証 | zod | 4.6.7 |
| UI | React / react-dom / react-router / Vite | 19.3.1 / 19.3.1 / 8.5.1 / 8.3.6 |
| テスト | Vitest / @vitest/coverage-v8 / fast-check | 5.1.0 / 5.1.0 / 4.10.2 |
| UI テスト | Testing Library(react 16.3.3, user-event 14.6.8, jest-dom 7.0.1) / jsdom | 31.0.0 |
| E2E | Playwright / @axe-core/playwright | 1.65.0 / 4.14.0 |
| 品質 | ESLint / typescript-eslint / Prettier | 10.14.0 / 8.72.1 / 3.9.10 |
| 開発 | tsx / concurrently / wait-on | 4.23.15 / 10.0.7 / 9.5.1 |
| コンテナ | node:26-alpine（複数段、非 root） | - |
| インフラ | Terraform（AWS プロバイダー `~> 6.0`）、ECS、RDS、S3、CloudFront、ALB、Secrets、CloudWatch Synthetics | - |

## beer-game（v1）

TypeScript ^5.9.3、Fastify ^5.6.1、React ^19.2.0、Vitest ^4.0.6、ESLint ^9.39.1、Prettier ^3.6.2、Playwright ^1.56.1、`@aws-sdk/client-sqs` ^3.1162.0、`@fastify/cors` / `rate-limit` / `static`。版は `^` の範囲指定。CI は Node 22、PostgreSQL 16。

## ルート

Gulp ^5.0.0、dotenv ^17.2.3、marked ^18.0.9、plantuml-encoder ^1.4.0。MkDocs Material、PlantUML、Mermaid 11.17.2、MathJax 3。ルートの `Dockerfile` は Ubuntu 24.04 + Node 22 + Nix。

## 設計上の正本

技術スタックの版とサポート期限は `docs/design/beer-game2/tech-stack.md`（2026-11-09 に公式情報で確認とある）。本スキャンでは npm や公式サイトでの再確認はしていない。beer-game3 の版は未決定。
