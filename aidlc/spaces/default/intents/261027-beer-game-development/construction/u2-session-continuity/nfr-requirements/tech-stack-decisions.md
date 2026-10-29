# Tech Stack Decisions - U2

## Decisions

- U1 の TypeScript、Fastify、React、PostgreSQL、Vitest、Playwright を継続します。
- PostgreSQL を session state の唯一の authority とし、in-memory Map は production persistence に使用しません。
- Recovery token 生成は Node.js `crypto.randomBytes`、cookie integrity は署名済み cookie または opaque session store を使用します。
- SSE と polling fallback を維持し、event gap は snapshot reconciliation で修復します。

## Rationale

新しい platform を増やさず、U1 の modular monolith 内で continuity capability を完成させるためです。

## Sources

`technology-stack.md`、U1 tech stack decisions、`functional-design/functional-spec.md`。
