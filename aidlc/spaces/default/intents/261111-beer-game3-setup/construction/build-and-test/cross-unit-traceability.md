# 全 Unit の網羅の確認 - beer-game3

`aidlc engine sensor-traceability --stage build-and-test` の出力（2026-11-14）。

## 判定: 不合格（NFR の一部が「未実装」として残っている）

| 区分 | 件数 | 結果 |
| :--- | :--- | :--- |
| 機能要件（FR1.1〜FR15.1） | 41 件 | すべて、受入条件を通して網羅 |
| 受入条件（AC1.1.1〜AC5.7.2） | 全件 | すべて、試験またはソースのファイルに対応（例: AC5.3.1 → `verification/load/runner.ts`、AC5.5.1 → `verification/e2e/keyboard-flow.e2e.ts`、AC5.7.1 → `verification/e2e/main-operations.e2e.ts`） |
| 非機能要件（NFR1〜NFR11） | 11 件中 NFR10 だけが網羅 | NFR1、2、3、4、5、6、7、8、9、11 は、詳細な `NFRx.y` の一部が「未実装」 |

## 網羅できていない詳細の NFR（Unit ごと）

出力の `not_built` を、Unit ごとにまとめる。これらは、その Unit の NFR の文書にある詳細な要件が、その Unit のコード生成の追跡表に実装の対象として載っていない、という意味である。多くは、別の Unit が実装する、稼働環境の工程が担う、またはその Unit の設計文書に確認の方法だけが書かれている項目である。

| Unit | 網羅できていない詳細の NFR |
| :--- | :--- |
| u1-walking-skeleton | NFR5.2、NFR5.3（U4 が実装）、NFR6.8（U4）、NFR7.2、NFR7.3（U5） |
| u3-facilitation | NFR1.1、NFR2.1〜2.3、NFR3.1〜3.4、NFR3.7、NFR4.1〜4.4、NFR5.1、NFR5.2、NFR6.1〜6.7、NFR6.9、NFR6.10、NFR7.1、NFR9.2 |
| u4-access-recovery | NFR3.7、NFR6.11、NFR7.2 |
| u5-results-retention | NFR1.1、NFR1.2、NFR2.1〜2.5、NFR3.1〜3.5、NFR4.1〜4.5、NFR5.1、NFR5.2、NFR6.1〜6.8（6.1〜6.8 の一部）、NFR7.1〜7.3、NFR8.1、NFR8.2、NFR9.5、NFR11.1、NFR11.2 |
| u6-nfr-verification | NFR3.7（U1 の NFR を参照する記述が拾われたもの。U6 に NFR3.7 はない） |

## 解釈と報告

- 機能と受入条件はすべて網羅され、実行した試験は全部通っている（`test-results.md`）。
- NFR の「未実装」は、実装がない、という意味とは限らない。U3 と U5 では、NFR の要件の多くを、U3・U5 のコード生成の追跡表（`code-generation/traceability.json`）が `OK` として列挙していない。実際には試験があるもの（例: U5 の保持と削除の試験、U3 の履歴の試験）が多いが、追跡表に載っていないため、機械が網羅と認めない。
- 本ステージで追跡表を書き換えることはしない（承認済みの Unit の記録のため）。承認の場で、(a) 各 Unit の追跡表を実際の試験に対応づけて補う、(b) このまま不合格を承認して Operation 以降の工程へ進む、のどちらにするかを決める必要がある。
