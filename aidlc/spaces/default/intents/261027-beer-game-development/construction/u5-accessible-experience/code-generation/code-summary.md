# Code Summary - U5 Accessible Experience

## Implemented scope

| Area | Main paths | Result |
|---|---|---|
| Browser UI | `apps/beer-game/src/ui/`、`index.html`、`vite.config.ts` | 作成・参加・復帰・lobby、週次プレイ、進行役、観察、振り返り、CSV / JSON export、保持状態を実装。keyboard、focus、live region、200% zoom、chart と table の同値表示を含む。 |
| Browser / API contract | `src/api/app.ts`、`src/ui/browser-api.ts`、共有 `contract-summary.md` | 同一 origin の cookie / Origin 検査、role-safe API、SSE live / replay、U2 操作、U3 export、U4 status / retry を接続。rate limit は 429、過大 payload は 413。 |
| Shared state | `src/infrastructure/postgres-game-repository.ts`、`migrations/005_u5_shared_game_store.sql`、`src/application/game-service.ts`、`src/infrastructure/outbox-dispatcher.ts` | game、session、参加者、意思決定、冪等性、結果、outbox を PostgreSQL transaction で共有。cookie session の digest と idempotency response を保護し、別 process の復帰、競合、SSE、U3 表示、U4 retry を検証。 |
| Edge / delivery | `infra/main.tf`、`.github/workflows/beer-game-u1.yml`、`package.json`、Playwright / Vitest 設定 | CloudFront / ALB 経路、header・cookie 転送、SSE timeout、2 API task と CPU scaling、CI の PostgreSQL / E2E を追加。 |
| Tests and diagnostics | `tests/u5/`、`tests/e2e/u5*.spec.ts`、`performance/`、`tests/manual/u5-accessibility.md` | BDD / integration、2 process race、browser E2E、単一 clock の synthetic 性能、75 client の負荷診断を追加。 |

## Verification completed

| Check | Result | Scope |
|---|---|---|
| U1〜U5 suite | 198 / 198 passed | PostgreSQL integration を含む。 |
| Line coverage | 90.49% | infrastructure を含む。目標 80% 以上。 |
| Browser matrix E2E | 15 / 15 passed | U5 の 3 scenario を Chromium、Firefox、WebKit、Chrome for Testing、Edge で実行。U1 と performance の Chromium scenario も通過。 |
| Format / lint / typecheck | passed | 既存 project の設定。 |
| Terraform | `fmt`、1.9.8 Docker の `init -backend=false` と `validate` passed | 静的な構成検証。 |
| 2 process integration | 10 / 10 passed | 同じ PostgreSQL に接続した別 OS process で認証、入力、冪等性、SSE、U3 / U4 を検証。 |
| DB load diagnostic | 15 game、75 SSE、375 polling、失敗 0 | 2 Fastify instance / 別 PostgreSQL pool。snapshot p95 364 ms。 |
| Chromium synthetic | 入力 p95 32.8 ms、SSE 反映 p95 158.8 ms、polling 反映 p95 959.4 ms、50 週 chart / table 描画 3.6 ms | local browser と単一観測 clock。実 AWS edge / 75 user steady load の SLO 判定ではない。 |

## Tests written but not executed

| Test / acceptance activity | Reason |
|---|---|
| AWS staging の CloudFront / ALB 経由の認証・SSE 再接続 smoke | staging の配備・接続情報が本作業環境にない。IaC の静的検証と local provider test のみ実施。 |
| 75 user × 15 分、50 週状態での本番相当 end-to-end 負荷 | local diagnostic は短時間・別測定で、15 分 steady load と browser commit-to-render の同時条件を満たさない。 |
| Chrome / Edge / Firefox / Safari 最新 2 世代の実 browser keyboard matrix | Chrome for Testing、Edge、Firefox、WebKit の現行 1 version の自動 E2E は通過。Safari 本体と各 browser の 2 世代目、および全主要 flow の手動 keyboard 確認は未実施。 |
| Windows NVDA + Chrome、macOS VoiceOver + Safari の手動受入 | 支援技術の手動操作と記録が未実施。`tests/manual/u5-accessibility.md` に手順を記載。 |

## Deviations and remaining work

U1 の process 内 Map が正本だったため、U5 の browser 実装に必要な 2 task 整合性を確認する目的で、共有 PostgreSQL repository、cookie session、event / outbox、U3 表示、U4 retry まで変更範囲が広がりました。承認済み計画の Step 8 は staging 相当の edge / 75 user steady load の証拠がまだ揃わず、Step 9 も手動受入と handoff の最終確認が残るため、チェックしていません。

AWS staging と実 browser の受入が済むまで、NFR1 の負荷下性能、NFR5 / NFR6 の実 browser・支援技術、NFR9 の staging 配備を達成済みとは扱いません。実施時は `docs/operation/` の定義済み手順を使用します。

WebKit のローカル HTTP 試験は Secure cookie を保存しないため、復帰シナリオの test context に限って cookie を注入しました。本番の `Secure` 属性は変更していません。matrix の並列 fixture は idempotency key をシナリオごとに一意にしました。

## Sources

- `code-generation-plan.md`、`unit-test-instructions.md`
- `construction/u5-accessible-experience/functional-design/functional-spec.md`
- `construction/u5-accessible-experience/nfr-requirements/`
- `construction/u5-accessible-experience/nfr-design/`
- `construction/u5-accessible-experience/infrastructure-design/`
- `inception/contract-design/contract-summary.md`

## Assumptions & Open Questions

- ローカル synthetic の数値は本番の SLO 証拠ではありません。staging の実 edge と手動 browser matrix の記録が必要です。
