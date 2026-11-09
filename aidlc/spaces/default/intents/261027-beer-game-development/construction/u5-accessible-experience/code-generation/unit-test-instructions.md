# Unit Test Instructions - U5 Accessible Experience

## Framework and runner

既存 `apps/beer-game/vitest.config.ts`、Vitest、React Testing Library、Playwright を使用します。BDD の Given/When/Then を失敗する実行可能 test として先に定義し、最小実装、green、refactor の順に進めます。runner と U5 scoped command は最初の scenario より前に確認します。

## Unit-scoped commands

| Purpose | Exact command |
|---|---|
| U5 unit / integration | `npm --prefix apps/beer-game test -- --run tests/u5` |
| U5 browser E2E | `npm --prefix apps/beer-game run e2e:u5` |

`e2e:u5` は Step 1 で `package.json` に登録します。browser E2E の前に既存の local server / test database を起動し、test fixture を作成します。U5 の test file だけを選ぶ command を使い、全 suite の回帰確認は最終検証で別途実行します。

## Coverage and test volume

各 component に 5〜8 test を目安とし、U5 全体で scenario / component 35〜50 件を計画します。U5 の対象 source と全 application の line coverage 80% 以上を維持します。契約境界は cookie / Origin、role isolation、version / idempotency、SSE / polling、export、retention status を含みます。browser E2E は主要 flow、keyboard、200% zoom、通知と focus、chart / table 等価性を含みます。

## Fixtures and isolation

ゲーム、4 role、進行役、観察者、50 週 series、削除 Saga の partial / failed / completed fixture を用意します。network 境界は contract fixture を使い、PostgreSQL を要する integration は既存 local compose の test database を使います。AWS 呼出は adapter を mock します。時間、SSE 切断、out-of-order response、cookie expiry は制御可能な clock / transport を使います。secret や表示名を test log に出しません。

## Manual evidence

Windows NVDA + Chrome、macOS VoiceOver + Safari と Chrome / Edge / Firefox / Safari 最新 2 世代の keyboard 操作は、OS・browser・screen reader version と対象 flow を記録します。75 接続と fallback の performance は別の負荷 / synthetic 証跡に残します。

## Sources

- `code-generation-plan.md`
- `construction/u5-accessible-experience/nfr-requirements/tech-stack-decisions.md`
- `construction/u5-accessible-experience/infrastructure-design/cicd-pipeline.md`
- `apps/beer-game/package.json`

## Assumptions & Open Questions

- provider contract が確定するまでは E2E fixture の response shape を推測しません。
