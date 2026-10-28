# Practices Discovery Evidence

## Repository and History Evidence

| Evidence | Observation | Resulting practice |
|---|---|---|
| Git history | `chore:` と `docs(requirements):` の日本語 Conventional Commits が存在 | 日本語 Conventional Commits を継続 |
| Branch state | `develop`、`main`、`origin/main` が同じ commit を指す | interview で `develop` 統合、release 時の `main` merge を確定 |
| `package.json` | Node.js ESM。test / lint / format / type-check script はない | formatter、linter、type-check を新規導入 |
| `aidlc/spaces/default/memory/team.md` | 5 practice section は未確定 | interview の回答を新しい team baseline とする |

## CI and Deployment Evidence

| Evidence | Observation | Resulting practice |
|---|---|---|
| `.github/workflows/mkdocs.yml` | `main` push で docs build と GitHub Pages deploy | merge 後の自動反映という既存傾向を application staging に適用 |
| `.github/workflows/docker-publish.yml` | tag / manual trigger で GHCR publish | production は人が release を承認する方針と整合 |
| `aidlc/spaces/default/codekb/case-study-beer-game-simulation/code-quality-assessment.md` | application test gate、coverage、lint、format、type-check がない | CI で formatter / linter / type-check を必須化 |
| `aidlc/spaces/default/codekb/case-study-beer-game-simulation/dependencies.md` | Docker、GitHub Actions、GHCR、MkDocs、SonarQube が存在 | staging / production automation の利用候補として保持 |

## Development and Architecture Evidence

| Evidence | Observation | Resulting practice |
|---|---|---|
| `aidlc/spaces/default/codekb/case-study-beer-game-simulation/code-structure.md` | `apps/beer-game/` は空で、application convention はない | application の quality configuration を明示的に導入 |
| `aidlc/spaces/default/codekb/case-study-beer-game-simulation/technology-stack.md` | Node.js 22.x は運用 tooling 用。application stack は未選定 | language 固有の formatter / linter / type-check は技術選定に合わせる |
| `aidlc/spaces/default/codekb/case-study-beer-game-simulation/architecture.md` | 決定論的 core、原子的週確定、server-side authorization が候補境界 | BDD scenario と Integration Test の重要対象にする |
| `aidlc/spaces/default/codekb/case-study-beer-game-simulation/business-overview.md` | 4 役割の同期型週次進行と終了後分析が中核価値 | 1 game / 4 roles / 1 week を walking skeleton にする |

## Interview Decisions

`practices-discovery-questions.md` で次を確定しました。

- Q1: `develop` に統合し、release 時に `main` へ merge する。
- Q2: 1 game / 4 roles / 1 week の thin end-to-end slice を先行する。
- Q3: BDD とし、Given/When/Then の振る舞い例を実装前に定義する。
- Q4: `main` merge 後に staging へ自動反映し、production は手動承認後に deploy する。
- Q5: formatter、linter、type-check を CI で必須化し、失敗時は merge しない。

## Testing Evidence

- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/code-quality-assessment.md` は、50 週 golden test、property-based test、週確定 Integration Test、authorization negative test を推奨しています。
- classic scope の 80% line coverage floor と Standard Test Strategy を適用します。
- team は BDD を選択し、Given/When/Then の behavior examples を実装より先に置くことを確定しました。

## Sources

- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/code-structure.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/technology-stack.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/dependencies.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/code-quality-assessment.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/architecture.md`
- `aidlc/spaces/default/codekb/case-study-beer-game-simulation/business-overview.md`
- `aidlc/spaces/default/memory/team.md`
- `aidlc/spaces/default/intents/261027-beer-game-development/inception/practices-discovery/practices-discovery-questions.md`
- `.github/workflows/mkdocs.yml`
- `.github/workflows/docker-publish.yml`
- `package.json`
- Git history through commit `258e450367415d0593b66b369c0bf432c4dcec3e`

## Assumptions & Open Questions

None.
