# 業務ルール - U5 u5-results-retention

U5（結果と出力、保持と削除）の業務ルールです。ストーリー US4.1、US4.2、US5.1 の受入条件（AC）を、実行できる規則にしました。規則の番号は `BR{グループ}.{連番}` で、U1〜U4（グループ 1〜20）に続けて、次のグループを使います: 21 結果の開示、22 結果の表示、23 出力、24 保持と削除、25 自動終了、26 定期処理。

出典: `requirements.md`（FR10.2、FR13、FR14、NFR7、NFR9）、`stories.md`、`entities.md`、`contract-summary.md`、`functional-design-questions.md`（Q1 指標を切り替え表も併記、Q2 参加者と進行役だけ、Q3 アプリの設定だけ、Q4 毎回の設定で判定、Q5 一時停止中も自動終了の対象、Q6 RFC 4180 と BOM で値は元のまま、Q7 整数のセントと CSV と同じ名前、Q8 物理削除でログだけ、Q9 アプリ内タイマーとロック）。

仮の数値（30 日、30 日、60 分、100 件）は設定値として持ち、NFR 要件の工程で確定します。

## 規則（YAML が正本）

```yaml
rules:
  - id: BR21.1
    statement: 結果は、ゲームが終了した（status が ended）ときだけ返す。終了前は、誰にも返さない
    category: constraint
    applies_to: [Reporting.results]
    trigger: GET /games/{gameId}/results の要求（資格情報が有効で、結果を見る権限がある人）
    logic: IF status が ended THEN 結果を返す。IF status が preparing、running、paused のいずれか THEN 結果を返さず、他役割の時系列を含まない拒否を返す。進行役でも終了前は返さない（進行役は進行管理の画面で進行を見る。U3）
    violation: 403 forbidden。理由は「ゲームが終了するまで、結果は見られません」。他役割の値、週の数、確定済みの週の数を応答に含めない
    source: FR13.1
  - id: BR21.2
    statement: 結果を見られるのは、そのゲームの参加者（有効な復帰用 token）と進行役だけ。観察者、資格情報なし、別のゲーム、存在しないゲームは、同じ 403 の本文で拒否する
    category: authorization
    applies_to: [AccessControl.requireResultsViewer]
    trigger: 結果の取得
    logic: IF 呼び出した人が、そのゲームの参加者（失効していない token。役割が割り当てられている）または進行役 THEN 通す。IF 観察者、無効または期限切れまたは失効した token、無効なコード、別のゲームの資格情報、存在しない（削除済みを含む）ゲーム THEN 資格情報の無効と区別できない同じ 403 の本文で拒否する。観察者は、終了後もチーム全体の集計値（U4）だけを見て、役割別の時系列は見ない
    violation: 403 forbidden。本文は U4 の無効な資格情報と同一（BR19.1）。ゲームや役割の存在を応答の違いで明かさない
    source: FR13.1
  - id: BR21.3
    statement: 結果は、確定済みの週の、需要・注文・在庫・受注残・出荷・費用を、4 役割ぶん返す
    category: constraint
    applies_to: [ResultsView, ResultRole, ResultWeek]
    trigger: 終了したゲームの結果の取得
    logic: THEN 確定済みの各週について、4 役割それぞれの入荷（receipt）、受注（ordersReceived）、出荷（shipped）、週末在庫（inventory）、週末受注残（backlog）、発注または生産要請（decision）、当週費用（weeklyCost）、累積費用（cumulativeCost）を、週の昇順で返す。顧客需要（customerDemand）は第 1 週から confirmedWeeks まで、設定の需要系列から返す。確定前の入力は含めない。途中で終了したゲームは、確定済みの週までを返す。確定済みの週がないゲームは、空の系列と 0 を返す（エラーにしない）
    violation: 未確定の値が応答にあれば、投影の誤りとして試験が失敗する
    source: FR13.1
  - id: BR21.4
    statement: 結果に、参加者の表示名、コード、token、ハッシュ、冪等の識別子を含めない
    category: constraint
    applies_to: [ResultsView]
    trigger: 結果の取得
    logic: THEN 役割と数量と費用だけを返す。誰が入力したかは含めない（出力にだけ含める。BR23.2）
    violation: 含めてはならない値が応答にあれば、投影の誤りとして試験が失敗する
    source: FR13.1
  - id: BR21.5
    statement: 結果の取得は読み取りだけ。ゲームの状態、版、履歴、lastOperationAt を変えない
    category: constraint
    applies_to: [Reporting.results, Reporting.export]
    trigger: 結果または出力の取得
    logic: THEN 行を占有せず、1 回の読み取りで整える。終了したゲームは書き込みを受けないため、占有しなくても内容は変わらない。取得のたびに履歴を足さない
    violation: 該当なし（試験で、取得の前後に版と履歴の件数が同じことを確かめる）
    source: FR13.1
  - id: BR22.1
    statement: 結果画面は、指標を切り替えて選び、選んだ指標について 4 役割の系列を同じ週の軸に重ねて表示する
    category: policy
    applies_to: [結果画面]
    trigger: 結果画面を開く、または指標を選ぶ
    logic: 指標は次の 6 つ。需要（各役割が受けた注文。ordersReceived。小売店では顧客需要）、注文（各役割の発注または生産要請。decision）、在庫（inventory）、受注残（backlog）、出荷（shipped）、費用（weeklyCost または cumulativeCost）。選ぶと、4 役割の系列が同じ週の軸（第 1 週から confirmedWeeks）に重なって表示される。初期の指標は費用。役割の並びと系列の記号は、どの指標でも同じ
    violation: 該当なし
    source: FR13.1
  - id: BR22.2
    statement: 系列は、色だけに頼らず、線種・印・凡例で区別できる
    category: constraint
    applies_to: [結果画面, 凡例]
    trigger: 複数の系列の表示
    logic: THEN 役割ごとに、線種（実線、破線、点線、一点鎖線）と印（丸、四角、三角、ひし形）の組を固定で割り当て、凡例に同じ線種と印と役割名を示す。色は補助で、色を取り除いても、線種と印だけで 4 つを区別できる。色は、コントラスト比 3:1 以上の、色覚の違いに配慮した組を使う
    violation: 該当なし（試験で、線種と印が役割ごとに異なることを確かめる）
    source: FR13.2
  - id: BR22.3
    statement: 費用は、週ごとと累積を切り替えて表示する
    category: policy
    applies_to: [結果画面]
    trigger: 指標が費用のとき、切り替えを選ぶ
    logic: IF 週ごと THEN 当週費用（weeklyCost）の系列を表示する。IF 累積 THEN 累積費用（cumulativeCost）の系列を表示する。初期は累積。画面の最後に、チームの累積費用の合計（teamCumulativeCost）を示す
    violation: 該当なし
    source: FR13.1
  - id: BR22.4
    statement: グラフと同じ数値の表を、グラフの下に置く
    category: policy
    applies_to: [結果画面]
    trigger: 指標の選択
    logic: THEN 選んだ指標について、行を週、列を 4 役割とする表を表示する。表の数値はグラフの数値と同一で、表は見出し（caption）と行・列の見出しを持つ。グラフが読めない人も、表で同じ情報を得られる
    violation: 該当なし
    source: FR13.1
  - id: BR22.5
    statement: 金額は整数の最小単位（セント）で受け取り、画面では通貨の形に整えて表示する
    category: calculation
    applies_to: [結果画面の費用]
    trigger: 費用の表示
    logic: THEN 整数のセントを $ と小数 2 桁の形に変換して表示する。変換は整数の割り算と剰余で行い、浮動小数点を使わない。チームの合計は、整数の和を変換するため、表示の合計は端数の誤差なく一致する
    violation: 該当なし
    source: FR10.2
  - id: BR22.6
    statement: 終了したゲームの画面から結果画面へ移れる。終了前は結果画面へ移る導線を出さない
    category: policy
    applies_to: [ゲーム画面, 進行役のボード]
    trigger: status が ended になったゲームの画面
    logic: IF status が ended THEN 参加者の画面と進行役のボードに「結果を見る」を出す。IF ended でない THEN 出さない。終了前に結果画面の URL を直接開いたときは、BR21.1 の拒否の理由を画面に示す
    violation: 該当なし
    source: FR13.1
  - id: BR23.1
    statement: 出力は進行役だけができ、終了したゲームだけが対象。参加者、観察者は拒否する
    category: authorization
    applies_to: [Reporting.export]
    trigger: GET /games/{gameId}/export?format=csv|json の要求
    logic: IF 呼び出した人が進行役 かつ status が ended THEN 出力する。IF 参加者、観察者、無効な資格情報、別のゲーム、存在しないゲーム THEN 資格情報の無効と区別できない同じ 403 の本文で拒否する。IF 進行役だが status が ended でない THEN 409 state で拒否する。IF format が csv でも json でもない、または欠落 THEN 422 validation で拒否する
    violation: 403 forbidden、409 state、422 validation
    source: FR14.1
  - id: BR23.2
    statement: 出力は、ゲーム設定と、確定済みの週ごと・役割ごとの記録を含み、キット準拠かカスタムかを識別できる
    category: constraint
    applies_to: [ExportDocument, ExportRecord, ExportGame]
    trigger: 出力の生成
    logic: THEN records は、確定済みの週の昇順、同じ週では factory、wholesaler1、wholesaler2、retailer の順に、1 週・1 役割を 1 行とする。各行は、gameId、setupKind（kit または custom）、week、role、customerDemand、receipt、ordersReceived、shipped、inventory、backlog、decision（発注または生産要請）、weeklyCostCents、cumulativeCostCents、decidedByKind、decidedByDisplayName を持つ。decidedByDisplayName は、decidedByKind が participant のとき、その入力者の表示名（入れ替え済みの参加者を含む）。facilitator のとき、または空のときは空。JSON の game には、ゲーム設定（name、weekCount、初期在庫、初期の遅延の数量、在庫と受注残の単価、需要系列、状態、終了の理由、作成と終了の日時）を含める。setupKind は、画面が示す種別と同じ判定に従う（U2）
    violation: 該当なし
    source: FR14.1
  - id: BR23.3
    statement: CSV は RFC 4180 に従い、UTF-8 に BOM を付け、区切り文字・引用符・改行を含む値でも崩れず、元の値のまま読み戻せる
    category: constraint
    applies_to: [CSV の出力]
    trigger: format が csv の出力
    logic: THEN 先頭に BOM（U+FEFF）を付け、1 行目をヘッダ（列名）とする。行の終わりは CRLF。カンマ、二重引用符、CR、LF のいずれかを含む値は、二重引用符で囲み、値の中の二重引用符は 2 つにする。値の中の改行は、値の一部として保つ。値の先頭が =、+、-、@ であっても、値を変えない（先頭に文字を足さない）。読み戻した値が元と一致することを優先する。Content-Type は text/csv; charset=utf-8
    violation: 該当なし（試験で、カンマ・改行・二重引用符・先頭が = の表示名を含む出力を、CSV の読み戻しで元の値と照合する）
    source: FR14.2
  - id: BR23.4
    statement: CSV と JSON は、同じ中間表現から作り、数値が一致する
    category: constraint
    applies_to: [CSV の出力, JSON の出力]
    trigger: 出力の生成
    logic: THEN ExportRecord の列を一度だけ作り、CSV の行と JSON の records の要素に同じ値を同じ名前で写す。JSON の数値は JSON の数として出し、文字列にしない。同じゲームの CSV を読み戻した records は、JSON の records と、件数・順序・値が一致する。Content-Type は application/json; charset=utf-8
    violation: 該当なし（試験で、同じゲームの CSV と JSON を突き合わせる）
    source: FR14.1
  - id: BR23.5
    statement: 出力の金額は、整数のセントで出し、項目名に単位を示す
    category: calculation
    applies_to: [ExportRecord, ExportGame]
    trigger: 出力の生成
    logic: THEN weeklyCostCents、cumulativeCostCents、inventoryUnitCostCents、backlogUnitCostCents は整数のセントで出す。小数、通貨記号、桁区切りは付けない。浮動小数点を使わない
    violation: 該当なし
    source: FR10.2
  - id: BR23.6
    statement: 出力の setupKind は kit または custom の 2 値だけ
    category: constraint
    applies_to: [ExportRecord.setupKind, ExportGame.setupKind]
    trigger: 出力の生成
    logic: THEN U2 の種別の判定の結果を、そのまま出す。ほかの値を作らない
    violation: 該当なし
    source: FR14.1
  - id: BR23.7
    statement: 出力はファイルとして保存できる形で返し、キャッシュさせない
    category: policy
    applies_to: [出力の応答]
    trigger: 出力の生成
    logic: THEN Content-Disposition を attachment とし、ファイル名は beer-game-{gameId}.csv または beer-game-{gameId}.json とする。Cache-Control は no-store。ファイル名にゲーム名や表示名を使わない
    violation: 該当なし
    source: FR14.1
  - id: BR23.8
    statement: 出力に、コード、token、ハッシュ、冪等の識別子、操作の履歴を含めない
    category: constraint
    applies_to: [ExportDocument]
    trigger: 出力の生成
    logic: THEN 参加コード、進行役用コード、観察者用コード、復帰用 token、それらの照合用の値、冪等の識別子、操作の履歴（U3）を含めない。含めるのは BR23.2 の項目だけ
    violation: 含めてはならない値が出力にあれば、出力の誤りとして試験が失敗する
    source: FR14.1
  - id: BR23.9
    statement: 出力ボタンの近くに、表計算ソフトで開くときの注意と、列名の意味の一覧を日本語で必ず示す
    category: policy
    applies_to: [進行役のボード, 結果画面]
    trigger: status が ended のゲームで、出力ボタンを表示するとき
    logic: THEN 出力ボタン（CSV、JSON）の近くに、次の 2 つを常に表示する（折りたたまない）。(1) 注意: 「表計算ソフトで CSV を開くとき、表示名が式として実行されないよう注意してください。信頼できない表示名があるときは、テキストとして読み込んでください」。(2) 列名の一覧: 各列名（week、role など）の意味と単位を日本語で示す表。役割の値（factory など）と日本語の役割名の対応も示す。出力の列名と役割の値は、読み戻すための識別子として英語のままにする（NFR11 の「出力」は画面の文言と解釈する。U5 の NFR Requirements の Q6 の A）
    violation: 該当なし（画面の試験で、注意と一覧が出力ボタンと同時に表示されることを確かめる）
    source: FR14.2
  - id: BR23.10
    statement: 表示名が =、+、-、@ で始まるものは、参加と担当者の入れ替えで拒否する
    category: validation
    applies_to: [GameSession.join, GameSession.replaceParticipant]
    trigger: 参加者の参加、または進行役による担当者の入れ替えで、表示名を受け取るとき
    logic: IF 前後の空白を取り除いた表示名の先頭が =、+、-、@、タブ、復帰のいずれか THEN 拒否する。拒否は表示名の形式の検証の失敗であり、占有の前に行う（U3 の入力検証の順）。すでに保存されている表示名は変えない（出力の値も変えない）。出力の CSV は値を変えないため、この制限が表計算ソフトで式として実行される恐れへの入口の対策になる。U1 の join と U3 の replace の入力検証を変更する
    violation: 422 validation。理由は「表示名の先頭に使えない文字があります」、直し方は「= + - @ 以外の文字で始まる名前にしてください」
    source: NFR6
  - id: BR24.1
    statement: 保持期間は、アプリケーションの設定で指定し、全ゲームに共通。既定は 30 日（仮の値）
    category: policy
    applies_to: [RetentionPolicy.retentionDays]
    trigger: 起動
    logic: THEN 環境変数で retentionDays を 1 以上 3650 以下の整数で指定する。未指定なら 30。範囲の外、または整数でない値なら起動を拒否する。ゲームごとの保持期間は持たない
    violation: 起動を拒否する（設定の誤り）
    source: NFR7
  - id: BR24.2
    statement: 終了したゲームは、終了から保持期間を過ぎたら削除する。判定はそのときの設定で毎回行う
    category: calculation
    applies_to: [Retention.findExpired]
    trigger: 定期処理
    logic: IF status が ended かつ 現在の時刻が endedAt に retentionDays 日を足した時刻以降 THEN 削除の対象とする。判定のたびに現在の設定を使い、ゲームに保持期間を記録しない。設定を短くすると、すでに終了したゲームも、新しい期間を過ぎていれば次の処理で対象になる。終了していないゲームは対象にしない。例: 既定の 30 日で、終了から 31 日たったゲームは対象。設定を 7 日にしたとき、終了から 8 日たったゲームは対象
    violation: 該当なし
    source: NFR7
  - id: BR24.3
    statement: 削除は、ゲームに紐づくすべてのデータを、同じ保存の中で、全部か全くなしかで行う
    category: constraint
    applies_to: [GameLifecycle.delete]
    trigger: 削除の対象のゲーム
    logic: THEN ゲーム、設定と需要系列、参加者、割当て、週の記録、遅延の枠、参加コードと進行役用コードと観察者用コード、復帰用 token、冪等の記録、操作の履歴を、1 回の保存の中で削除する。途中で失敗したら、すべて元に戻す。一部だけ残った状態を作らない。接続元ごとの試行の窓（U4）はゲームに紐づかないため対象外で、既存の掃除に任せる
    violation: 失敗したら全体を戻し、次の周期でやり直す
    source: NFR7
  - id: BR24.4
    statement: 削除したゲームのコードは無効になり、そのゲームへの要求は、存在しないゲームと同じ 403 で拒否される
    category: constraint
    applies_to: [AccessControl, GameSession]
    trigger: 削除後の、参加コード、進行役用コード、観察者用コード、token による要求
    logic: THEN コードと token の行が消えているため、照合に失敗する。参加の試行は、無効なコードとして U4 の窓に数えられる。状態、結果、出力、入力の要求は、資格情報の無効と区別できない同じ 403 の本文を返す
    violation: 403 forbidden
    source: NFR7
  - id: BR24.5
    statement: 削除の前に、ゲームの行を占有して、対象であることを再検査する。すでに削除されていれば何もしない
    category: constraint
    applies_to: [GameLifecycle.delete]
    trigger: 削除の対象として選んだゲーム
    logic: IF 占有の中で、status が ended で、期限を過ぎている THEN 削除する。IF 条件を満たさない（設定が変わった、など） THEN 削除せず、対象から外す。IF ゲームが見つからない（ほかの処理が先に削除した） THEN 何もせず、失敗に数えない（冪等）
    violation: 該当なし
    source: NFR7
  - id: BR24.6
    statement: 削除の記録は、ログにだけ残し、ゲームの識別子、削除の時刻、理由だけを含める。データベースには何も残さない
    category: policy
    applies_to: [Retention]
    trigger: ゲームを削除したとき
    logic: THEN ログに、event、gameId、deletedAt、reason（retentionExpired）だけを出す。表示名、ゲーム名、コード、token、件数以外の中身を含めない。「削除済みのゲーム」の表は持たない。削除したゲームの識別子は、ログ以外では、以後存在しないゲームとして扱う
    violation: 該当なし（試験で、ログ行に表示名とコードが含まれないことを確かめる）
    source: NFR7
  - id: BR24.7
    statement: 終了していないゲームは、保持期間では削除しない
    category: constraint
    applies_to: [Retention.findExpired]
    trigger: 定期処理
    logic: IF status が preparing、running、paused THEN 削除の対象にしない。放置されたゲームは、まず自動終了（BR25.1）してから、終了の時刻から保持期間を数える
    violation: 該当なし
    source: NFR7
  - id: BR25.1
    statement: 最後の操作から自動終了の期間（既定 30 日、仮の値）を過ぎた、終了していないゲームを、自動で終了する。一時停止中のゲームも対象にする
    category: calculation
    applies_to: [Retention.findStale]
    trigger: 定期処理
    logic: IF status が preparing、running、paused のいずれか かつ 現在の時刻が lastOperationAt に autoEndDays 日を足した時刻以降 THEN 自動終了の対象とする。autoEndDays は 1 以上 3650 以下の整数で、アプリケーションの設定として指定する。未指定なら 30。範囲の外なら起動を拒否する。例: 最後の操作から 30 日たった進行中のゲームは対象。一時停止のまま 30 日たったゲームも対象
    violation: 該当なし
    source: NFR7
  - id: BR25.2
    statement: 最後の操作の時刻（lastOperationAt）は、状態を変える操作の保存と同じ保存の中で更新する。閲覧は数えない
    category: calculation
    applies_to: [Game.lastOperationAt]
    trigger: 状態を変える操作
    logic: IF 次のいずれかの操作が成功し、状態が変わった THEN 同じ保存の中で lastOperationAt を現在の時刻にする: ゲームの作成、参加、役割の割当て（準備中の戻しを含む）、開始、参加者の入力、進行役の代理入力、週の確定、一時停止、再開、終了、担当者の入れ替え。IF 状態の取得、結果の取得、出力、履歴の取得、冪等の再送（前回と同じ結果を返すだけ）、拒否された要求 THEN 更新しない。復帰用 token の最後の操作の時刻（U4）とは別で、互いに影響しない
    violation: 該当なし
    source: NFR7
  - id: BR25.3
    statement: 自動終了は、ゲームを終了し、終了の理由を autoEnd とし、その時点から保持期間を数える
    category: policy
    applies_to: [GameSession.autoEnd]
    trigger: 自動終了の対象のゲーム
    logic: THEN U3 の autoEnd を呼ぶ。status を ended にし、endedAt を現在の時刻、endReason を autoEnd にし、操作の履歴に end（reason が autoEnd、actorKind が system）を同じ保存の中で足す。currentWeek と確定前の入力は変えない。終了後は、参加者の確定の操作を拒否する（U3）。終了の時刻が保持期間の起点になる
    violation: 該当なし
    source: NFR7
  - id: BR25.4
    statement: 自動終了の前に、ゲームの行を占有して、対象であることを再検査する
    category: constraint
    applies_to: [GameSession.autoEnd]
    trigger: 自動終了の対象として選んだゲーム
    logic: IF 占有の中で、status が終了していない かつ 現在の時刻が lastOperationAt に autoEndDays 日を足した時刻以降 THEN 終了する。IF 選んだあとに操作があり lastOperationAt が新しくなっていた THEN 終了せず、対象から外す。IF すでに終了している THEN 何もしない（冪等）。IF ゲームが見つからない THEN 何もせず、失敗に数えない。U3 の autoEnd は、この再検査の条件（期限の時刻）を受け取れるようにする
    violation: 該当なし
    source: NFR7
  - id: BR25.5
    statement: 自動終了と削除は別の期限で、同じ周期で終了と削除を続けて行わない
    category: constraint
    applies_to: [Retention.run]
    trigger: 定期処理
    logic: THEN 自動終了の判定と削除の判定は、それぞれ別に行う。自動終了で endedAt を現在の時刻にしたゲームは、retentionDays が 1 以上のため、同じ処理の中では削除の対象にならない（BR24.2）。削除の対象は、処理の開始時点で、すでに終了していたゲームだけ
    violation: 該当なし
    source: NFR7
  - id: BR26.1
    statement: 定期処理は、アプリケーションの中のタイマーで、起動時に 1 回、その後は一定の間隔（既定 60 分、仮の値）で動く
    category: policy
    applies_to: [Retention.scheduler]
    trigger: アプリケーションの起動
    logic: THEN 起動の完了後に 1 回、その後は jobIntervalMinutes ごとに、1 回の処理を行う。間隔は 1 以上 1440 以下の整数（分）で、アプリケーションの設定として指定する。範囲の外なら起動を拒否する。時刻は注入した Clock の現在時刻で得る。試験では、1 回の処理を時刻を指定して直接呼べる。タイマーは、アプリケーションの停止を妨げない
    violation: 起動を拒否する（設定の誤り）
    source: NFR7
  - id: BR26.2
    statement: 複数のインスタンスが動いても、1 回の処理は二重に実行しない
    category: constraint
    applies_to: [Retention.run]
    trigger: 1 回の処理の開始
    logic: THEN PostgreSQL のアドバイザリロックを試みて取る。取れたインスタンスだけが処理し、処理が終わったら（失敗でも）解放する。取れなければ、今回は何もせず、skipped として結果をログに出す。待たない。メモリ上の保存では、同じプロセスの実行中の印で二重実行を防ぐ。接続が切れたときは、ロックも自動で解放される
    violation: 該当なし
    source: NFR7
  - id: BR26.3
    statement: 1 回の処理は、自動終了を先に、削除を後に行い、それぞれ 1 回の処理で扱う数に上限を置く
    category: constraint
    applies_to: [Retention.run]
    trigger: 1 回の処理
    logic: THEN まず自動終了の対象を、lastOperationAt の古い順に batchLimit 件まで選んで終了する。次に削除の対象を、endedAt の古い順に batchLimit 件まで選んで削除する。上限を超える分は、次の周期で扱う。削除の対象は、自動終了を行う前の時点で選ぶ（BR25.5）。選ぶときは、直近の処理で失敗したゲーム（失敗から 1 周期の間、プロセスのメモリに識別子を持つ。再起動で消えてよい）を除いて、正常なゲームを先に batchLimit 件まで選ぶ。失敗が続くゲームが batchLimit 件以上たまっても、後ろの正常なゲームが処理されなくなることはない。失敗から 1 周期たったゲームは、また対象に戻る
    violation: 該当なし
    source: NFR7
  - id: BR26.4
    statement: 1 つのゲームの失敗は、ほかのゲームの処理を止めない。失敗はログに出して、次の周期でやり直す
    category: constraint
    applies_to: [Retention.run]
    trigger: 自動終了または削除の失敗
    logic: IF 1 つのゲームの自動終了または削除が失敗した THEN 失敗に数え、ゲームの識別子と失敗の種類をログに出し、残りのゲームの処理を続ける。ゲームの内容（表示名など）をログに出さない。IF 1 回の処理の全体が失敗した（データベースに接続できない、など） THEN ログに出して、その回を終え、次の周期でやり直す。タイマーは例外で止まらない。処理の失敗は、ゲームの参加者と進行役の要求に影響しない。終了時に、自動終了の数、削除の数、失敗の数、所要時間（RetentionRunResult）をログに出す
    violation: 該当なし
    source: NFR7
  - id: BR26.5
    statement: 起動時の定期処理は、HTTP の受け付けの開始を遅らせない
    category: constraint
    applies_to: [Retention.scheduler]
    trigger: アプリケーションの起動
    logic: THEN 起動時の 1 回の処理は、待たずに始める（非同期）。処理が遅くても、HTTP の受け付けを遅らせない。処理は、ほかのゲームの要求と同じ接続の資源を使うが、1 つのゲームごとに短い保存に分けて行う
    violation: 該当なし
    source: NFR7
  - id: BR26.6
    statement: アプリケーションの停止では、タイマーを止め、実行中の処理の終わりを待ってから閉じる
    category: policy
    applies_to: [Retention.scheduler]
    trigger: アプリケーションの停止（SIGTERM、SIGINT）
    logic: THEN 次の周期を予約しない。実行中の 1 回の処理があれば、現在のゲームの保存が終わるまで待ち、新しいゲームの処理を始めない。そのあとで、ロックを解放し、接続を閉じる。待つ時間には上限を置き、超えたら閉じる
    violation: 該当なし
    source: NFR7
```

## 規則の概要

| グループ | 規則 | 内容 |
| :--- | :--- | :--- |
| 21 結果の開示 | BR21.1〜BR21.5 | 終了後だけ、参加者と進行役だけ、確定済みの週、個人の情報を含めない、読み取りだけ |
| 22 結果の表示 | BR22.1〜BR22.6 | 指標の切り替え、線種と印と凡例、費用の切り替え、表の併記、セントの表示、導線 |
| 23 出力 | BR23.1〜BR23.10 | 進行役だけ、含める項目、RFC 4180、CSV と JSON の一致、整数のセント、種別、ファイル名、含めないもの、注意と列名の説明、先頭が式になる表示名の拒否 |
| 24 保持と削除 | BR24.1〜BR24.7 | 設定、期限の判定、まとめて削除、削除後の拒否、再検査、ログの記録、終了前は対象外 |
| 25 自動終了 | BR25.1〜BR25.5 | 対象、最後の操作の時刻、終了の理由、再検査、終了と削除は別の期限 |
| 26 定期処理 | BR26.1〜BR26.6 | タイマー、二重実行の防止、順序と上限、失敗の扱い、起動を遅らせない、停止 |

## 上流の資料

`entities.md`、`unit-of-work.md`、`contract-summary.md`、`requirements.md`、`stories.md`、`functional-design-questions.md`
