# Discovered Rules

## Mandated

- ALWAYS integrate feature work into `develop` and merge `develop` into `main` for a release.
- ALWAYS build the 1 game / 4 roles / 1 week thin end-to-end slice before expanding the feature set.
- ALWAYS define Given/When/Then behavior examples before implementation.
- ALWAYS deploy `main` merges automatically to staging and require manual approval before production deployment.
- ALWAYS run the configured formatter, linter, and type-check in CI.

## Forbidden

- NEVER merge a change while formatter, linter, or type-check CI checks are failing.

## Sources

- `aidlc/spaces/default/intents/261027-beer-game-development/inception/practices-discovery/practices-discovery-questions.md`

## Assumptions & Open Questions

None.
