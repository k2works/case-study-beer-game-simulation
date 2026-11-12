# Discovered Rules（最終版）

> 人が述べた厳守事項のみ。面談（Q1〜Q8）で既存ルールを変える回答はなく、新規の厳守事項は追加していない。beer-game3 用 CI/Deploy の新設や AWS 専用化は方針であり、evidence.md の決定として記録する。

## Mandated

- ALWAYS integrate feature work into `develop` and merge `develop` into `main` for a release.
- ALWAYS build the 1 game / 4 roles / 1 week thin end-to-end slice before expanding the feature set.
- ALWAYS define Given/When/Then behavior examples before implementation.
- ALWAYS deploy `main` merges automatically to staging and require manual approval before production deployment.
- ALWAYS run the configured formatter, linter, and type-check in CI.

## Forbidden

- NEVER merge a change while formatter, linter, or type-check CI checks are failing.
