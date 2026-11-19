## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-product-lead-agent
**Date:** 2026-11-11T08:53:34Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/mockups.md > S3 役割別プレイ（「発注数を確定する」ボタンと「入力: 保存済み」）、S4 進行管理（入力列）、aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/interaction-spec.md > 発注数の入力欄（キーボード） | S3 は「値は入力した時点で保存」(AC1.4.4、AC3.1.2) としながら「発注数を確定する」ボタンも置いている。どちらの時点で「入力済み」になるかが書かれていない。S4 の確定ボタンが押せる条件、「4 役割のうち N が入力済み」の数え方、「置き換わり」(AC2.2.1「最後に確定した値」) の発生時点が、この定義に依存する。操作仕様の「Enter で「確定する」ボタンへ移らず」も意味が読み取れない。「確定」が参加者の入力確定と進行役の週確定の両方に使われ、「確定する は常に右下」(design-system-mapping.md) とも衝突する | 入力の保存と「入力済み」とを別の状態にするのか、同じにするのかを決め、ボタンの要否を明示する。状態名を整理して、参加者の操作と週の確定で言葉を分ける（例: 「入力を送る」と「週を確定する」）。S3 の状態、S4 の「入力済み」、「4 役割のうち N」の数え方、置き換わりの発生時点を、その定義でそろえる | New |
| R-02 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/mockups.md > S6 結果・比較（指標の選択、凡例）、aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/interaction-spec.md > 結果の比較 | AC4.1.1 と FR13.1 は「需要と全役割」の時系列の比較を求めている。S6 の指標は注文・在庫・受注残・出荷・費用だけで、凡例も 4 役割だけである。需要の系列を見る場所がない。操作仕様の線種 4 種と印 4 種も 4 役割分で、需要を足すと区別が足りなくなる | 需要を指標または常時の系列として S6 に加える。系列が 5 つになるので、線種と印の割当てと凡例、表の列を決め直す | New |
| R-03 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/mockups.md > S0 参加入口、S5 観察、S1 公開範囲 | 観察者の入り方が設計されていない。S0 には「参加する」ボタンが 1 つだけで、観察者として入る選択がない。観察者はプレイ中に見る画面 (S5) だが、進行中のゲームへの参加は AC1.2.3 で拒否される。観察者に別のコードが要るのかも、どの上流にも書かれていない。S1 の「観察者に見せる」を外した場合に S5 が何を示すかも、FR4.3 の「進行役が許可した」に対して未定義である | 観察者の入口（選択する操作、使うコード、進行中でも入れる理由）を S0 に設計する。上流に根拠がなければ人に決めてもらう。公開範囲が外れているときの S5 の状態を追加する | New |
| R-04 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/mockups.md > 画面の移り変わり、S1 作成後、S4 | 進行役が進行役用コードを使って（再）入場する画面がない。コードは作成時に 1 度だけ表示され、再発行もしない。ブラウザを閉じた後に S4 へどう戻るか、コードを入力する欄があるか、ブラウザに保存するかが書かれていない。参加者が S4 の URL を直接開いたとき (AC2.8.2) の画面も、状態表の「権限なし」の一語だけである。画面の移り変わりの図は S3 と S4 を相互に行き来できるように見えるが、4 役割の参加者は S4 に入れない | 進行役の入場（コードの入力欄、保存の扱い、失った場合の案内）と、権限がないときの拒否画面を設計する。移り変わりの図は、進行役の経路と参加者の経路を分けて描き直す | New |
| R-05 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/mockups.md > S3 状態（切断・復帰）、S0 | S3 は AC3.2.1〜AC3.2.3 を引用しているが、復帰できない場合の画面がない。24 時間を超えた復帰用 token の拒否と「進行役による入れ替えが必要」の案内 (AC3.2.3) がどこにも描かれていない。AC2.6.1 で担当者を入れ替えられた元の参加者の画面（token が無効になった後に何を見るか）も定義されていない | 復帰用 token が期限切れ・無効・入れ替え済みのときの参加者の画面と案内文を、S0 または S3 の状態として追加する | New |
| R-06 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/mockups.md > S1（「系列を編集」） | 需要系列を設定できること (FR1.2、AC1.1.2) が必須なのに、「系列を編集」の先の画面や部品が描かれていない。最大 50 個の値の入力方法（1 つずつ、貼り付け）、各値の検証（非負の整数）、週数を変えたときの扱いが未定。キーボードだけでゲーム作成を完了する条件 (AC5.5.1) の中心部分が、確認表の対象にも入っていない | 系列の編集の部品（入力方法、検証、長さの表示、週数との連動）を操作仕様に追加し、確認表の対象に含める | New |
| R-07 | Major | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/accessibility-checklist.md > 知覚できること「拡大」、aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/refined-mockups-questions.md > Q3 | Q3 は幅 1024px 以上だけを対象にしているのに、確認表は「200% に拡大しても、内容が失われず、横にスクロールしない」を求めている。1280px の画面で 200% にすると実質 640px になり、2 列の S3 や広い S4 の表は崩れるか横スクロールになる。設計のどこにも解決が書かれておらず、「実装時に確認」に先送りされている | 拡大時の画面の組み替え（1 列への縮退、表の扱い）を方針として決める。または、確認表の条件をどう満たすか（対象の幅の定義を含む）を明記して、Q3 と整合させる | New |
| R-08 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/mockups.md > S3 履歴（「履歴 (v 開く)」） | Q2 の回答は A（1 画面に状況・入力欄・履歴を並べる）だが、履歴の見出しは「(v 開く)」で、折りたたむ形 (C) に読める。図は 2 行を開いた形で、どちらか判別できない | Q2 のとおり常に表示するのか、折りたたむのかを決めて、見出しと説明をそろえる。折りたたむなら Q2 の回答を取り直す | New |
| R-09 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/mockups.md > S3（「ほかの役割: 4 役割のうち 3 が入力済み」） | 「ほかの役割」の分母が 3 のはずなのに「4 役割のうち」と書かれている。自分を含むのかが曖昧で、試験の期待値が定まらない。「確定待ち」の文言は「ほかの役割を待っています（4 役割のうち N）」と違う書き方になっている | 分母が自分を含む 4 か、含まない 3 かを決め、画面の文言を 1 つに統一する | New |
| R-10 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/mockups.md > S1（設定の種類、初期） | 「設定の種類」の初期値が「キット準拠」で、需要系列も「階段状の例」を選んだ形である。FR1.7 と AC1.6.2 では、系列が未確定の間キット準拠のゲームは作れず、常に「カスタム」と表示される。注記はあるが、最初に見える状態が作れない状態になっている。ラジオが利用者が選べる操作なのか、自動の表示なのかも曖昧である | 系列が未確定の間は「カスタム」を初期表示にするか、読み取り専用の表示にする。キット準拠の選択肢を出す条件を書く | New |
| R-11 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/mockups.md > S6（出力ボタン）、画面の一覧（S6 の主な利用者） | S6 の主な利用者は「全員」で、CSV・JSON の出力ボタンも描かれている。US4.2 の出力は進行役 (P2) の機能である。参加者と観察者に出力ボタンを見せるのか、見せないのかが書かれていない | 出力ボタンを出す相手（進行役だけ）を明記し、参加者・観察者の S6 の状態を追加する | New |
| R-12 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/accessibility-checklist.md > 知覚できること「画像の代替」、aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/interaction-spec.md > 結果の比較 | 確認表は「グラフに文章の要約を付ける」を「設計済み」としているが、S6 の画面案にも操作仕様にも要約の記述がない。データ点にキーボードで移動する案も、50 週 × 5 系列では移動先が極めて多い | 要約の位置と内容を S6 に書くか、状態を「未設計」に改める。データ点の移動は、表を代替手段とする前提で範囲を決める | New |
| R-13 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/interaction-spec.md > 利用の流れ 流れ 2、確認ダイアログ | 流れ 2 は「確認で「確定する」を選ぶ」と書くが、確認ダイアログのボタンは「実行する」と「やめる」である | ボタンの名前を 1 つに統一する（操作名を含める案も検討する） | New |
| R-14 | Minor | aidlc/spaces/default/intents/261111-beer-game3-setup/inception/refined-mockups/mockups.md > S0 状態（連続した失敗）、画面の一覧 | S0 は「待つ時間を示す」としているが、NFR6 は「一時的に拒否」とするだけで時間を定めていない。また画面の一覧に、画面を持たないストーリー（US3.1、US5.1〜US5.3、US5.7）が載っておらず、取りこぼしと区別できない | 待ち時間は仮の値として明示するか、時間を示さない文言にする。画面を持たないストーリーと理由を一覧に追記する | New |

### Summary

ストーリーと受入条件の引用は存在するものに対応しており、役割別の情報制約 (FR4.1〜FR4.5) を破る画面はない。ただし、入力の確定の意味、S6 の需要、観察者と進行役の入場、復帰できない場合の画面、系列の編集が未設計で、拡大時の条件も Q3 と整合しない。これらを直すまで、開発が問い返さずに進められる状態にはなっていない。
