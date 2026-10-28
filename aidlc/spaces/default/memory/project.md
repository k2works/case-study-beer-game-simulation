# Project-Level Rules

> Project-specific specialisation and corrections. Loaded after `org.md` and
> `team.md` as strict-additive guidance; contradictions with broader policy
> are rejected. Populated by practices-discovery and the self-learning loop.
>
> Use sparingly: most teams don't need a project layer. Reach for it
> only when this specific project needs stable, durable guidance beyond the
> team practice (for example, package-specific release checks or an additional
> regression suite for a legacy component).

## Way of Working

<!-- Project-specific specialisation. Example: -->
<!-- This monorepo requires package-scoped branch names and a package owner -->
<!-- review in addition to the team's normal merge policy. -->

- 現在の `main` と `develop` が同一 commit を指している事実だけでは branch strategy を確定せず、ユーザーの回答により `develop` 統合と release 時の `main` merge を採用した。 (learned 2026-10-27) <!-- cid:261027-beer-game-development:practices-discovery:120e9cdde171a57e93e8994af83383c8d64fd1c282327a9be59cea8640c4dea9 -->

## Walking Skeleton

<!-- Project-specific specialisation. Example: -->
<!-- The walking skeleton must exercise the legacy service adapter as well -->
<!-- as the new service boundary. -->

## Testing Posture

<!-- Project-specific specialisation. -->

- 実装後のテスト追加や低レベルの TDD のみではなく、業務ルールを Given/When/Then で先に固定する BDD を採用した。週次計算、冪等性、役割別認可を実行可能な振る舞いとして追跡するためである。 (learned 2026-10-27) <!-- cid:261027-beer-game-development:practices-discovery:0ae1d082aaae28d26451f4339d6842bbdebde0b181d20367fd99ec5b3f922f18 -->

## Guard Policy

<!-- Project-specific. Mode: strict, relaxed, or off. Strict here holds for every intent, whatever one person asks in chat; relaxed or off here applies to every intent whose policy came from its scope, unless the person sets another; changing this line changes it. A section under the retired Change Control heading, written by an earlier release, is still read. -->

## Deployment

<!-- Project-specific specialisation. -->

## Code Style

<!-- Project-specific specialisation. -->

## Tech Stack

<!-- Technology choices locked for this project. -->

## Decided

<!-- Decisions made in earlier stages that should not be re-asked. -->
<!-- Format: DECIDED: [decision] (Stage [slug], [date]) -->

## Scope Overrides

<!-- Custom scope rules for this project. -->

## Forbidden

<!-- Populated by practices-discovery affirmation gate. -->
<!-- Format: NEVER [behavior] (affirmed [date]) -->
<!-- Example: NEVER throw exceptions across service layer boundaries (affirmed 2026-05-17) -->

- NEVER merge a change while formatter, linter, or type-check CI checks are failing. (affirmed 2026-10-27)

## Mandated

<!-- Populated by practices-discovery affirmation gate. -->
<!-- Format: ALWAYS [behavior] (affirmed [date]) -->
<!-- Example: ALWAYS use Result<T,E> for fallible operations in service layer (affirmed 2026-05-17) -->

- ALWAYS integrate feature work into `develop` and merge `develop` into `main` for a release. (affirmed 2026-10-27)

- ALWAYS build the 1 game / 4 roles / 1 week thin end-to-end slice before expanding the feature set. (affirmed 2026-10-27)

- ALWAYS define Given/When/Then behavior examples before implementation. (affirmed 2026-10-27)

- ALWAYS deploy `main` merges automatically to staging and require manual approval before production deployment. (affirmed 2026-10-27)

- ALWAYS run the configured formatter, linter, and type-check in CI. (affirmed 2026-10-27)

## Corrections

<!-- Project-specific corrections from human feedback. -->
<!-- Format: NEVER/ALWAYS [behavior] (learned [date]) -->
- 既存リポジトリを brownfield として全体調査した結果、運用・文書基盤は存在する一方で `apps/beer-game/` にゲーム本体実装はないと判断した。以降の設計では、既存のドキュメントと運用自動化を再利用対象とし、ビールゲーム本体を新規実装対象として扱う。 (learned 2026-10-27) <!-- cid:261027-beer-game-development:reverse-engineering:ab8bb128f097801d396c5b3df83fe764b6f22a585b4c1361bed819e09c204d70 -->
- CodeKB は focused scan ではなく full rescan とし、`analyzed.paths: ./` で全体の現状を記録した。初回スキャンであり、要件・運用基盤・空のアプリ領域の関係を一貫して把握するためである。 (learned 2026-10-27) <!-- cid:261027-beer-game-development:reverse-engineering:81ad48dafc78e60b47dfa6f34468e54560959108a5aa5359d1ace11afe6e401f -->
- 観察者の集計値公開は、役割別の非公開情報を逆算できないチーム全体値に限定した。学習上の情報制約と観察性を両立するためである。 (learned 2026-10-27) <!-- cid:261027-beer-game-development:requirements-analysis:9b2a3dbc7f64530a87d06ba9298493824646168baf85a0883fa727b5fde90905 -->
- 参加者の再接続は account login ではなく browser 保存の復帰 token を採用した。個人情報の収集を抑えつつ、同一役割に復帰するためである。 (learned 2026-10-27) <!-- cid:261027-beer-game-development:requirements-analysis:e22a3a914e5c4b7e2de00c95615e0bb359652b7ddb160fee9fb7d6be4b51d482 -->
- 週次進行と永続状態は GameSession が所有し、副作用のない決定論的計算を SimulationEngine に分離した。 (learned 2026-10-28) <!-- cid:261027-beer-game-development:domain-design:059d3673ede61ef8ad8e1e7d056054583b7f72d2a3bff17f0117d7c2609917d6 -->
- JSD preset 未確定時は custom series で技術検証を先行できるが、JSD 準拠の受入判定は保留する。 (learned 2026-10-28) <!-- cid:261027-beer-game-development:delivery-planning:fd6dbc7e5072f011b387629acbb6e5a64347bf91e4d31e39ae98a7eba02d367b -->
