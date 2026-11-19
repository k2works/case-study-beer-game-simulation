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

- 共通の土台（保存の型、セッションの層）を作り替えるスライドの後続は、振る舞いの試験より先に実装を書くと失敗を確かめられない。土台を変える最初のスライドで、後続の振る舞いの試験も先に書いて失敗を確かめてから実装する。順序を守れなかったときは、規則を壊すと試験が落ちることを個別に確かめて code-summary に記録する。 (learned 2026-11-12) <!-- cid:261111-beer-game3-setup:code-generation:4024cc170ea9e7046d48c668b069216f692c4b60143bd07af5c728399a365467 -->

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

- NEVER merge a change while formatter, linter, or type-check CI checks are failing. (affirmed 2026-11-11)

## Mandated

<!-- Populated by practices-discovery affirmation gate. -->
<!-- Format: ALWAYS [behavior] (affirmed [date]) -->
<!-- Example: ALWAYS use Result<T,E> for fallible operations in service layer (affirmed 2026-05-17) -->

- ALWAYS integrate feature work into `develop` and merge `develop` into `main` for a release. (affirmed 2026-10-27)

- ALWAYS build the 1 game / 4 roles / 1 week thin end-to-end slice before expanding the feature set. (affirmed 2026-10-27)

- ALWAYS define Given/When/Then behavior examples before implementation. (affirmed 2026-10-27)

- ALWAYS deploy `main` merges automatically to staging and require manual approval before production deployment. (affirmed 2026-10-27)

- ALWAYS run the configured formatter, linter, and type-check in CI. (affirmed 2026-10-27)

- ALWAYS integrate feature work into `develop` and merge `develop` into `main` for a release. (affirmed 2026-11-11)

- ALWAYS build the 1 game / 4 roles / 1 week thin end-to-end slice before expanding the feature set. (affirmed 2026-11-11)

- ALWAYS define Given/When/Then behavior examples before implementation. (affirmed 2026-11-11)

- ALWAYS deploy `main` merges automatically to staging and require manual approval before production deployment. (affirmed 2026-11-11)

- ALWAYS run the configured formatter, linter, and type-check in CI. (affirmed 2026-11-11)

## Corrections

<!-- Project-specific corrections from human feedback. -->
<!-- Format: NEVER/ALWAYS [behavior] (learned [date]) -->
- 既存リポジトリを brownfield として全体調査した結果、運用・文書基盤は存在する一方で `apps/beer-game/` にゲーム本体実装はないと判断した。以降の設計では、既存のドキュメントと運用自動化を再利用対象とし、ビールゲーム本体を新規実装対象として扱う。 (learned 2026-10-27) <!-- cid:261027-beer-game-development:reverse-engineering:ab8bb128f097801d396c5b3df83fe764b6f22a585b4c1361bed819e09c204d70 -->
- CodeKB は focused scan ではなく full rescan とし、`analyzed.paths: ./` で全体の現状を記録した。初回スキャンであり、要件・運用基盤・空のアプリ領域の関係を一貫して把握するためである。 (learned 2026-10-27) <!-- cid:261027-beer-game-development:reverse-engineering:81ad48dafc78e60b47dfa6f34468e54560959108a5aa5359d1ace11afe6e401f -->
- 観察者の集計値公開は、役割別の非公開情報を逆算できないチーム全体値に限定した。学習上の情報制約と観察性を両立するためである。 (learned 2026-10-27) <!-- cid:261027-beer-game-development:requirements-analysis:9b2a3dbc7f64530a87d06ba9298493824646168baf85a0883fa727b5fde90905 -->
- 参加者の再接続は account login ではなく browser 保存の復帰 token を採用した。個人情報の収集を抑えつつ、同一役割に復帰するためである。 (learned 2026-10-27) <!-- cid:261027-beer-game-development:requirements-analysis:e22a3a914e5c4b7e2de00c95615e0bb359652b7ddb160fee9fb7d6be4b51d482 -->
- 週次進行と永続状態は GameSession が所有し、副作用のない決定論的計算を SimulationEngine に分離した。 (learned 2026-10-28) <!-- cid:261027-beer-game-development:domain-design:059d3673ede61ef8ad8e1e7d056054583b7f72d2a3bff17f0117d7c2609917d6 -->
- JSD preset 未確定時は custom series で技術検証を先行できるが、JSD 準拠の受入判定は保留する。 (learned 2026-10-28) <!-- cid:261027-beer-game-development:delivery-planning:fd6dbc7e5072f011b387629acbb6e5a64347bf91e4d31e39ae98a7eba02d367b -->
- Full rescan は Standard の深さで実施し、深く読む範囲を要件・2 つのアプリ・CI・ルート設定に絞り、docs と個別ソースの大半は構成と行数で把握した。 (learned 2026-11-11) <!-- cid:261111-beer-game3-setup:reverse-engineering:dee13c356a06e1cb26772d882246e01e7de7c3276a9db72a400371242aa4e9ba -->
- ブラウザのバイナリ等で find が肥大する場合、ファイル一覧と行数の取得に限り、読み取り専用の git ls-files と wc を使う。内容の書込みには使わない。 (learned 2026-11-11) <!-- cid:261111-beer-game3-setup:reverse-engineering:c5b59dacde671d09c69bbc933aa9e168eb95a665b040805b3e2e0328bf1de35d -->
- 参加者の入力の判定の順は「占有 → 割当てと token の再検査 → 再送の照合 → 状態の検査」にする。入れ替えで失効した旧担当者が、以前に成功した識別子を再送しても 403 にするため（認可を再送の照合より先に置く）。 (learned 2026-11-12) <!-- cid:261111-beer-game3-setup:code-generation:a87f7aa49c6ff32435e18670440eec61de9b216e33e9709c1463aa23a7a04eef -->
- ハーネスの作業用ファイルが apps/beer-game3/aidlc/ に置かれ、prettier --check . を失敗させるため、apps/beer-game3/.prettierignore に aidlc を入れておく。 (learned 2026-11-12) <!-- cid:261111-beer-game3-setup:code-generation:a0571e56d718ad02d07ba346faffdc156aae90a068970ba1d1c694af6f9a5725 -->
- 参加者の入力の入力検証（zod）は、副作用がなく占有の時間を短くできるため、占有の前に行う。そのため、終了済みのゲームへの不正な表示名の入れ替えは 409 ではなく 422 になる。 (learned 2026-11-13) <!-- cid:261111-beer-game3-setup:code-generation:d88a2cb61c024ed8cfcf8de1e7519360fee1625508f87996a947a7ce136ec481 -->
- 役割変更の履歴の change には、設計の assign・reassign・replace に加えて unassign（準備中の未割当てへの戻し）を持つ。設計文書（entities.md、functional-spec.md の履歴の表）にも反映する。同じ役割への割当て直しのように何も変わらない要求は履歴に足さない。 (learned 2026-11-13) <!-- cid:261111-beer-game3-setup:code-generation:4278b4c643700d2c80dbebf18bae27407b9a68939e8b06b5af09992415d23c5e -->
- ソースの機械的な一括置換でも、python や heredoc を使わず、ファイルツールで書く。成果物だけでなく実装とテスト補助の編集も同じ規律にする。 (learned 2026-11-13) <!-- cid:261111-beer-game3-setup:code-generation:f33928f2c0083dba9a785015135d279288cfeea7d2177c21b508d1d70f56d383 -->
- 参加コードのように本文にある資格情報で試行を数える窓の検査は、本文の解析後（preValidation）に置く。認可は onRequest のまま本文の解析より前に置き、形式不正の本文は 422 で窓に数えない。 (learned 2026-11-13) <!-- cid:261111-beer-game3-setup:code-generation:ad886c1e8d0a23a860b4420d969fe6094365c9f0564423da9aa91b01eb1a43ed -->
- 無効な資格情報（なし、無効、不明・失効・期限切れ、権限なし、別のゲーム、存在しないゲーム）は、すべて同じ 403 の本文で返す。文言は画面が、自分の送った資格情報の種類から選ぶ。 (learned 2026-11-13) <!-- cid:261111-beer-game3-setup:code-generation:3a47cc419537676ee957b0f3a8f803c58d77870d4d536ac3d7bb3787fed3d152 -->
- 試行の窓の鍵は、生の IP アドレスでなく、正規化した接続元の鍵付きの要約を使う。DB に IP を残さず、ログの src とも同じ値で突き合わせられる。 (learned 2026-11-13) <!-- cid:261111-beer-game3-setup:code-generation:907ea45b1421385df3c8e6182602f045441442d8022ff934d1265cb814d1dd6f -->
- 履歴を必須にする保存の関数は、GameTx.updateGame(update, expectedVersion, logs) の引数 logs を必須にして実装する。履歴だけを足す関数は公開せず、静的な試験で確かめる。参加（join）と開始（start）は履歴の 7 種類に含まれないので、空の配列を明示する。 (learned 2026-11-13) <!-- cid:261111-beer-game3-setup:code-generation:d5c84ba41a47f143248d18ae6a396353086e53422d5d8594d3cf5756829ce833 -->
- 復帰用 token の失効は、return_tokens.revoked_at と participants.replaced_at を同じコミットで更新する。入れ替えた旧担当者の参加者の行と週の記録は、履歴と入力者のラベルを残すため消さず、ロビーや投影の一覧に replaced: true で残す。 (learned 2026-11-13) <!-- cid:261111-beer-game3-setup:code-generation:410dc9d2bf33ea1173c231a0c68049325dac1fae55cfccab8e949f0068024075 -->
- 進行管理の URL の直接要求（AC2.8.2）には専用の入口を足さず、GET /games/{gameId}/state が呼び出した人ごとの投影を返す設計で扱う。参加者の token は進行役の項目のない参加者の投影、無資格と別のゲームの進行役は 403 とする。 (learned 2026-11-13) <!-- cid:261111-beer-game3-setup:code-generation:14866b8d0c1ce0d17bb859ce4b228528ca8fb07c68239900ffbf8ad0593ac915 -->
