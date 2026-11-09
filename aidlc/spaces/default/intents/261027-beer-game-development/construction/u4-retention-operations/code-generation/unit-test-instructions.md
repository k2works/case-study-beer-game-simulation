# Unit Test Instructions - U4 Retention Operations

## Framework and command

既存 Vitest 設定 `apps/beer-game/vitest.config.ts` を使用します。最初の scenario を書く前に次の U4 限定 command が実行可能であることを確認します。

`npm --prefix apps/beer-game test -- --run tests/u4`

`test:u4` script は同じ範囲を指すよう追加します。全 suite と coverage は実装後の検証で別途実行します。

## Coverage and cases

各 component 5〜8 件を目安に、U4 の scenario / unit 20〜30 件と主要境界の integration test を実装します。既存 suite を green に保ち、repository 全体と U4 の line coverage 80% 以上を目標とします。対象は BR15.1〜BR15.7、NFR2.1〜NFR2.5、NFR3.1〜NFR3.4、NFR4.1、NFR7.1〜NFR7.4 です。

## Test ordering and fixtures

Given / When / Then の失敗する scenario を先に書き、各 feature slice の data / repository / domain / API / event adapter を通して最小実装します。green を確認してから refactor します。時間、jitter、event ID、HMAC key は deterministic fixture に注入します。単体 test は owner adapter / queue / clock を stub し、integration test は PostgreSQL transaction と Fastify request を実際に通します。重複、旧 attempt、保存失敗、権限なし、再起動、期限切れ receipt の復旧を含めます。

## Sources

- `code-generation-plan.md`
- `functional-design/rules.md`
- `infrastructure-design/cicd-pipeline.md`

## Assumptions & Open Questions

- CI の PostgreSQL test service と AWS adapter fixture は U4 実装時に追加します。
