## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-12T04:00:52Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/nfr-design/security-design.md > 個人情報と保持（「接続元を判定できるログを残す」） | セキュリティの設計は、無効なコードの失敗時に「接続元を判定できるログ」を残すとしている。しかし観測性の設計のログ項目（時刻、水準、要求の識別子、操作、ゲームの識別子、役割、結果、応答時間）に接続元はなく、「許可した項目だけ出す方式」と食い違う。NFR6.4 は表示名以外の個人情報をログに出さないと定めており、接続元の IP アドレスをそのまま出すとこれにも反する。実装者はどちらに従うか決められない | 接続元をログに出すか決める。出すなら、観測性の設計の許可項目に加え、NFR6.4 との整合（例: 鍵付きハッシュ化または切り詰めた値にする）を書く。出さないなら、security-design の該当文を削り、U4 の試行回数の制限が接続元を自前で取る前提を明記する | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/nfr-design/performance-design.md > 資源（「取り直しの応答に、状態の版を含め」）と設計 NFR3.1（「1 行の更新だけ」）、reliability-design.md > NFR2.2 | 版（Game.version）の扱いが 3 点で未確定。(1) 入力は「1 行の更新だけ」とあるが、BR5.9 と NFR2.2 は保存のたびに版を 1 増やし版を条件に更新すると定めており、入力でゲームの行の版を更新するのかが書かれていない。更新しないなら、入力済みの数（inputsDone）が変わっても版が変わらず、「版が変わったときだけ描画し直す」画面が進行役の入力済み表示を更新しない。更新するなら更新は 2 行になり「1 行」と矛盾する。(2) 契約の GameStateView に `version` の項目がなく、取り直しの応答に版を含める変更が契約に反映されていない。(3) 版の検査は読んだ値との比較だが、占有の中で読み直すのか、占有の前に読んだ値かが不明 | 入力、割当て、開始、確定のそれぞれで版を更新するか明記する（更新するなら「1 行」の表現を直す）。取り直しの描画判定に使う値を定め、契約の GameStateView に追加して contract-summary.md を同時に直す（追加は後方互換）。版の検査の値は占有の中で読み直した値とする | New |
| R-03 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/nfr-design/security-design.md > 鍵の管理（Q2 の A）、コードと token | 旧鍵・新鍵の併用が実装できる形まで書かれていない。entities.md の AccessCode は `codeHash` 1 列で鍵の識別子の列がなく、移行の進み具合（どの行が新鍵か）を判定できない。暗号化した値（`codeSealed`）の形式（鍵の識別子、IV、認証タグ）と IV を毎回新しくすることも未定義。また Bearer の資格情報は参加者 token（SHA-256）、進行役用コード（SHA-256）、観察者用コード（HMAC）で関数が異なるが、種類をどう判定して照会するか（全種類を試す等）が書かれていない。参加コードの一意制約の衝突時の再発行も未記載 | 鍵の識別子の保存先（列の追加か値への埋め込み）、`codeSealed` の形式、資格情報の種類の判定手順、コード衝突時の再発行を security-design.md に書く。列を足すなら entities.md の AccessCode にも反映する | New |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/nfr-design/performance-design.md > NFR3.7 順番待ち 3 秒、scalability-design.md > 行の占有の扱い | 3 秒の時間切れが行の占有の待ち（lock timeout）だけを指しており、接続プールからの接続取得の待ちと、占有中の処理の時間の上限が定義されていない。プールが詰まると占有を待つ前に無制限に待たされ、NFR3.7 を満たせない。また占有中にアプリケーションが固まると、そのゲームの書き込みが全て 503 になり続ける（logical-components.md に「占有の滞留」とあるが対策がない） | 接続取得の時間切れ、占有の待ちの時間切れ（3 秒）、トランザクション内の文の時間切れとアイドルの上限を明記し、それぞれの失敗が `unavailable` か `internal` のどちらになるかを定める | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/nfr-design/scalability-design.md > NFR4.2、performance-design.md > NFR3.4 | 占有の対象に参加（join）が含まれるか不明。BR4.6 の trigger に参加はないが、参加順の番号の採番（BR2.1）と開始との競合（BR2.3、ゲームが進行中になる瞬間の参加）には直列化が要る。join はパスに gameId がなく、コードからゲームを引いてから占有する順序になる。また取り直しは AccessControl の資格情報の照会と投影の読み取りで少なくとも 2 回の問い合わせになり得るが、「1 つの読み取りでまとめて取る」と書かれていて数が合わない | join も占有の対象とし、順序（コードの照会、占有、採番）を書く。取り直しの問い合わせの回数を 1 回にするか、2 回を許すなら NFR3.4 の予算に含めて書く | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u1-walking-skeleton/nfr-design/security-design.md > 入力とブラウザ | 保存場所が定められているのは参加者の token（localStorage）だけ。進行役用コードは再発行されない長期の資格情報なのに、ブラウザでの保持方法（localStorage、sessionStorage、メモリのみ）が決まっていない | 進行役用コード（と観察者用コード）のブラウザでの保持方法を決め、XSS への露出の観点で理由を書く | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| traceability.json の読み取り | 33 件の NFR ID（NFR1.1〜NFR7.3）が `upstream_ids` と `coverage` に揃っている。すべて status OK | 要件ファイルの ID と一致し、各 target が示す設計ファイルの節（performance、reliability、scalability、security、observability の各設計書）に実在する。U4・U5 に回す NFR5.2、5.3、6.8、7.2、7.3 は U1 側の構造が書かれている |
| 数値目標との照合 | 1 秒の取り直し、2 秒の反映、500 ミリ秒の確定、3 秒の占有待ち、270 回/秒の読み取りの独立 | 構造として満たせる設計。プールの大きさは実装時の測定に委ねられており、時間切れの定義は上の Minor 指摘のとおり不足 |
| Q1・Q2 との整合 | Q1 の A（行の占有）は scalability、performance、reliability で一貫。Q2 の A（旧鍵・新鍵の併用）は security-design にあり | 方針は整合。Q2 の実装の細部は Minor 指摘のとおり |
| 機能設計との整合 | BR4.6、BR4.7、BR4.8、BR5.7、BR5.9 の判定順（認可、冪等性の記録の照合、状態、検証）は一致。403 への統一は契約の forbidden と一致 | 版の扱いのみ Major 指摘のとおり不明確 |

### Summary

33 件の NFR はすべて追跡でき、行の占有（Q1）と HMAC の二重鍵（Q2）の方針は各設計書で一貫している。ただしログの接続元と NFR6.4 の食い違い、および版の扱い（入力の更新と契約への反映）の 2 点の Major は、実装前に解消することを強く勧める。Major は 2 件のため判定は READY とする。
