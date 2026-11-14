## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-13T22:04:30Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/infrastructure-design/cicd-pipeline.md > ワークフローの全体「変更の検出」、ジョブとゲート `e2e`; infrastructure-specification.md > 必須のチェックの設定 | 「飛ばしたジョブは成功と扱われる」という前提が、行列（matrix）の `e2e` には当てはまらない。`changes` が偽でジョブ全体が飛ばされると、行列は展開されず、チェックは展開前の名前（`e2e`）の 1 件だけが「飛ばし」として出る。一方、必須のチェックには「行列の 4 つ」（ブラウザごとの名前）を指定する設計になっている。その名前のチェックは一度も報告されず、beer-game3 以外の変更の PR が「待機中」のまま止まる。設計が避けたかった事態（Q1 の懸念）そのものになる。行列のチェックの名前の付け方（`name:` に何を入れるか）も定義されていない | 行列のジョブの扱いを設計し直す。例: 行列の結果を 1 つに集約する最後のジョブ（`if: always()` で全体の成否を判定する）を設け、必須のチェックはその集約ジョブだけにする。または、ブラウザごとの名前を `name:` で固定し、飛ばされたときに同じ名前で成功を報告する方法を決める。いずれの場合も、必須にするチェックの正確な名前の一覧を cicd-pipeline.md に書く | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/infrastructure-design/cicd-pipeline.md > ワークフローの全体「変更の検出」、ジョブとゲート `changes` | `changes` ジョブ自体が失敗した場合（`git diff` の基準が取れない、checkout の失敗など）の扱いがない。他のジョブは `needs: changes` を持つため、`changes` が失敗すると全部が「飛ばし」になり、飛ばしは必須のチェックとして成功と扱われる。`changes` は必須のチェックの一覧に入っていないので、検証が 1 つも動かないまま PR が統合できてしまう。統合の保護（`NEVER merge a change while formatter, linter, or type-check CI checks are failing.`）が静かに無効になる | `changes` の失敗が必ず統合を止めるようにする。例: `changes` を必須のチェックに加える、または集約ジョブが `needs` の結果に `failure` や `cancelled` を見つけたら失敗するようにする。この条件を cicd-pipeline.md に書き、定義の検査（Vitest）の対象に加える | New |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/infrastructure-design/cicd-pipeline.md > 環境の昇格と配備「成果物」行; traceability.json > NFR6.4 | NFR6.4 の「`npm ci --omit=dev` と `npm ls --omit=dev` で本番の依存に試験の依存が含まれないことを検査する」は、「環境の昇格と配備」の表に 1 行あるだけで、どのジョブのどの手順にも入っていない。`verify` の手順は `npm ci` → `npm run verify` で、`npm ci` の後に `--omit=dev` の導入を重ねると、試験の依存が消えて同じジョブの試験が壊れる。traceability.json は NFR6.4 を OK としているが、指す先に実行する場所がない | この検査を動かすジョブ（既存ジョブと別の手順、または別のジョブ）と、その必須のチェックの扱いを cicd-pipeline.md のジョブの表に足す。あるいは Vitest の検査として `npm run verify` に入れ、その旨を明記する。traceability.json の NFR6.4 の target もその場所に合わせる | New |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/infrastructure-design/cicd-pipeline.md > 変更の検出 | `git diff --name-only` の比較の基準が、起動の種類ごとに定義されていない。`pull_request`（基準の branch と PR の先頭）、`push`（`github.event.before`。新しい branch では全ゼロ、force push では取得できない）、浅い checkout（`fetch-depth`）の扱いが未定。実装者が推測する必要がある。また `schedule` と `workflow_dispatch` を常に「変更あり」とする方法（出力の上書き）も書かれていない | 起動の種類ごとの比較の基準、取得の深さ、基準が取れないとき「変更あり」に倒すことを明記する | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/infrastructure-design/cicd-pipeline.md > 変更の検出（対象のパス） | 検出の対象が `apps/beer-game3/**` とワークフロー自身だけである。`verify` は、リリース前の確認票（`docs/operation/` 配下）の存在と見出しを検査する Vitest を含む（`nfr-design/observability-design.md`）。確認票の削除や改変だけの PR では `verify` が飛ばされ、その検査が動かない。リポジトリの根にある設定（`.nvmrc` の位置、ロックファイル）が対象外でないかも確認されていない | 検出の対象に、`verify` の試験が読むすべてのパス（確認票の文書など）を加える。または、確認票の検査を別の経路で保証する | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/infrastructure-design/cicd-pipeline.md > ジョブとゲート `load-main`; monitoring-design.md > SLI と SLO | `load-main` が `changes` に依存するかどうかが書かれていない（`main` への PR で beer-game3 以外の変更のとき、必須のチェックが動くか飛ぶか）。また SLO の窓と所要の目標が整合しない。「必須のチェックが起動から 20 分以内」の SLO に対し、`e2e` の所要の目標が 20 分で、これに `changes`（1 分）と実行機の待ちが加わる。`load-main` も所要の目標 40 分で SLO が 40 分、`changes` の分が加わる。目標が上限と同じなら、95% の SLO は設計上、達成の余裕がない | `load-main` と `changes` の関係を明記する。SLO の閾値を所要の目標の合計（`changes` ＋ 最も遅いジョブ ＋ 待ち）より余裕のある値にするか、所要の目標を下げる。値は初期の仮説として書かれているため、整合した値を置いてから実測で見直す | New |
| R-07 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/infrastructure-design/monitoring-design.md > 警告、SLI と SLO | SLO の違反より前に出る警告が、実行時間と夜間の実行には存在しない（80% の注意の印は閾値の合否の指標だけ）。夜間の実行が動かなかった場合の検知手段がなく、リリース後は「起動する割合 95%」の SLI を誰がどう測るか（成果物の取得、API）が定義されていない。再実行だけで通った割合（0%）も、測る手順がない。また、公開リポジトリでは、リポジトリの活動が 60 日ない場合に定期実行が自動で無効になる仕様があり、夜間の本試験が黙って止まる点に触れていない | 各 SLI の測り方（誰が、いつ、何を見て）を 1 行ずつ書く。所要時間と夜間の不実行について、SLO の違反より前の注意の基準を置く。定期実行の自動無効化への対処（定期の確認、または手動実行の手順）をリリースの手順書の条件に足す | New |
| R-08 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/infrastructure-design/traceability.json > NFR3.3、NFR4.2、NFR2.1、NFR2.3 | 指す先の文書に、主張の内容が書かれていない箇所がある。NFR3.3 の「load-smoke の通常負荷の取り直し」と NFR4.2 の「load-smoke には含めない」は、cicd-pipeline.md の `load-smoke` の行（1 分、15 チーム）に書かれていない。NFR2.1 の「読み取り専用の接続」は infrastructure-specification.md に書かれていない。NFR2.3 が挙げる「concurrency の制御」は、不安定な試験の防止と関係がなく（キャンセルの制御）、実際の根拠は `retries: 0` と再実行を合格にしない運用である | target の記述を、文書に実在する内容に合わせる。または、cicd-pipeline.md の `load-smoke` の行に、取り直しの有無と最大想定の区間を含めないことを書き足す | New |
| R-09 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/infrastructure-design/cicd-pipeline.md > ワークフローの全体「並行実行の制御」 | `concurrency` の集合の作り方が自然言語だけで、夜間と手動を取り消さない条件（実行ごとに一意の集合の名前にするか、`cancel-in-progress` を起動の種類で切り替えるか）が未定。同じ集合に置くと、GitHub は待機中の実行を新しい実行で置き換えるため、夜間と手動が静かに落ちる。`schedule` と `workflow_dispatch` が `main` の定義で動く点（取得する `ref` と定義の版が食い違う）も、定義の検査の対象外である | 集合の名前の式と `cancel-in-progress` の式を、起動の種類ごとに表で示す。夜間と手動は、集合を共有しないことを明記する | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| traceability.json の読み取りと突き合わせ（手作業） | NFR1.1〜NFR11.2 の 34 件がすべて列挙され、N/A は NFR1.2、4.3、5.1、7.1、9.4、10.2 の 6 件で理由は妥当 | 網羅は取れている。ただし NFR6.4、NFR3.3、NFR4.2、NFR2.1、NFR2.3 は、指す先の文書の記述と合わない |
| 上流（nfr-design の logical-components、observability-design、reliability-design）との突き合わせ | ジョブ名、保持日数 7/30、終了コード 0/1/2、`main` への PR による本試験、夜間は `develop` を取得、`workflow_dispatch` の入力は既定 `develop`、`retries: 0`、最小の権限、シークレットなしは一致 | 上流との整合は良好。主な問題は GitHub Actions の必須のチェックと飛ばしの扱いにある |

### Summary

上流の設計との整合と、保持日数、終了コード、権限の設計は整っている。ただし、「飛ばしたジョブは成功と扱われる」という前提が、行列の `e2e` と、`changes` の失敗の場合に成り立たない。そのため、統合の保護が、beer-game3 以外の PR を止める、または beer-game3 の PR の検証を静かに飛ばす、のどちらにもなりうる。さらに NFR6.4 の検査を動かすジョブがない。この 3 点（Major）を直せば、実装できる状態になる。
