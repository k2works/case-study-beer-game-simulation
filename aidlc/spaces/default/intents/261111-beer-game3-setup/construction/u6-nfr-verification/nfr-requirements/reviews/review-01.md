## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-13T08:53:43Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-requirements/traceability.json > coverage（NFR6、NFR7、NFR9） と observability-requirements.md > NFR9.1〜NFR9.4、security-requirements.md > NFR6.1〜NFR6.4、NFR7.1〜NFR7.2 | 上流の NFR ID に、別の意味の U6 要件を同じ番号で付けている。上流 NFR9 は「ゲーム設定・役割変更・代理入力・週確定・停止・再開・終了の履歴を追跡できる」監査性だが、U6 の NFR9.1〜9.4 は負荷試験の結果の記録とブラウザ確認票である。上流 NFR6 は参加コードの強度・サーバー側の権限検証・試行回数の制限、上流 NFR7 は保持期間と削除だが、U6 の NFR6.x・NFR7.x は試験の接続先・CI の権限・試験データの扱いである。それでも traceability.json は NFR6、NFR7、NFR9 をすべて `OK` としている。さらに U6 の NFR3.3、NFR3.4、NFR4.1〜4.4 は、U1 の同じ番号の要件（NFR3.3 は週確定の処理 500 ミリ秒、NFR4.4 は読み取りが順番待ちに入らないこと）と内容が異なる。上流の要件が U6 の範囲で検証されているのか、他 Unit に任せているのかを、番号から読み取れず、後の工程で誤ったトレースになる | U6 固有の要件には、上流の NFR と衝突しない ID（例: `V6.x`）を付け、各行に「上流 NFRn のどの部分を検証するか」を明記する。上流 NFR6、NFR7、NFR9 のうち U6 が検証しない部分（監査履歴、保持と削除、権限の検証）は、担当 Unit を書いて `OK` から「他 Unit 担当」に改める。traceability.json もそれに合わせて作り直す | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-requirements/security-requirements.md > NFR7.2 と NFR6.3 | NFR7.2 は「資格情報の値を持つ要求の本文と見出しは、保存の前に伏せる設定を使う」としているが、その設定が何かを示していない。Playwright のトレースに、要求の本文や見出しを保存前に伏せる標準の設定があることは確認されていない。加えて、トレースの DOM スナップショットと画面の画像には、画面に表示された参加コードや進行役用コードそのものが写る。NFR6.3 は「資格情報の値を、試験の出力（ログ、結果の要約、成果物）に書き出さない」と定めており、失敗時にトレースを成果物として保存する NFR7.2・NFR9.3 と両立しない。このままでは、どちらの要件も満たせないか、満たしたと主張できない | 伏せる手段を具体的に決める（例: トレースを保存せず画面の画像と要約だけにする、保存前に処理で書き換える、試験の資格情報は使い捨ての架空値であり保持 7 日の成果物に残ってよいと明記して NFR6.3 の対象から成果物を外す）。NFR6.3 と NFR7.2 の対象範囲を矛盾なく書き直し、確かめ方も検査できる形にする | New |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-requirements/performance-requirements.md > NFR3.5 | プルリクエストごとの短い負荷試験（1 分、15 チーム）が「NFR3.1〜NFR3.4 と同じ値」で合否を決めるとしているが、統計として成り立つかを示していない。各チームは 1 分あたり 1 週しか確定しないため、1 分間では週確定がおよそ 15 件、他の画面への反映の測定は多くても 60 件程度で、95 パーセンタイルの判定が 1 件の外れ値で決まる。同居した GitHub-hosted の実行環境（NFR4.4 で保守的になると自ら認めている）で、2 秒・1 秒の閾値を固定で適用すると、環境の揺れで落ちる。一方 NFR2.3 は、再実行で通すことを成功として扱わないと定めており、揺れた場合の扱いが決まらない。また、最大想定（270 台）の区間が短い試験に含まれるのか、10 分の本試験だけなのかも、NFR3.3・NFR3.5・NFR4.2 を読み比べても判定できない | 短い試験の最小の標本数、立ち上げ期間（ウォームアップ）の除外、閾値超過時の扱い（再測定の可否を含む）を決める。または、短い試験は件数の少ない指標の合否を外し、5xx の件数と取り直しの応答など標本の多い指標だけで判定する。最大想定の区間を短い試験に含めるかどうかを NFR3.5 に明記する | New |
| R-04 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-requirements/performance-requirements.md > NFR3.5（夜間の定期実行） | 夜間の定期実行は「`main` への統合後」とあるが、team の方針は `develop` に統合し、リリース時にだけ `main` へ merge する。GitHub の定期実行は既定の branch（`main`）の内容で動くため、`develop` に溜まる劣化を夜間の本試験は捉えない。早期に劣化を検知するという NFR3.5 の目的と合わない | 夜間の本試験が検査する branch（`develop` を明示して checkout するか、`main` のみを対象にするか）を決めて書く | New |
| R-05 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-requirements/reliability-requirements.md > NFR2.1、NFR2.2 と tech-stack-decisions.md > 方針（HTTP の公開の面だけを使う） | 負荷試験のスクリプトは HTTP の公開の面だけを使うとしているが、NFR2.1 は「すべてのゲームで週の連続・二重確定なし・保存値の一致」を検査し、NFR2.2 はデータベースとプロセスの片付けを定める。整合性を HTTP の応答（役割別の投影）だけで確かめられるのか、データベースを直接読むのか、アプリケーションと試験用のデータベースを誰が起動・破棄するのかが書かれておらず、開発者が推測で決めることになる | 整合性の検査の入口（HTTP の取得結果か、読み取り専用のデータベース接続か）と、起動・終了の責任（スクリプトか CI のワークフローか）を一文で決める | New |
| R-06 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/construction/u6-nfr-verification/nfr-requirements/performance-requirements.md > NFR8.1〜NFR8.3 | 上流 NFR8 の 3 条件のうち「色だけに依存せず状態を示す」に対応する U6 の要件がない（NFR8.3 のグラフの線と印は系列の区別だけで、一時停止・エラーなど状態の表示は対象外）。axe-core の検査は色だけに頼った表示を一般には検出しない | 状態表示が色だけに依存しないことの検査を NFR8 系の要件に足す。または U6 の範囲外とする理由を書く | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| traceability（手動確認） | traceability.json の NFR1〜NFR11 が指す要件行（NFR1.1〜NFR11.2）は、すべて成果物の中に存在する | 参照先の欠落はない。ただし NFR6、NFR7、NFR9 は番号だけが一致し、意味が上流と異なる（1 件目の Major） |
| 上流・隣接 Unit との照合 | 引用された U1 の NFR3.7、負荷の前提（75 台・270 台）、契約 C1 の rate_limited は、実在し内容が一致する | 引き継ぎ自体は正しい。無効なコードの試行だけを数える設計のため、有効な参加の負荷が制限に当たる懸念は見当たらない |

### Summary

参照の欠落はなく、負荷の前提や Q&A の決定は上流と整合している。一方で、U6 固有の要件が上流の NFR 番号を別の意味で使っていてトレースが誤解を生むこと、トレースの資格情報の伏せ方が実現手段のないまま NFR6.3 と矛盾すること、短い負荷試験の合否判定が統計的に成り立つか不明なことの 3 点の Major があり、開発者が推測なしで実装できる状態ではない。
