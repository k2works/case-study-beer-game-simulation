# 業務ルール - U4 u4-access-recovery

U4（復帰と権限）の業務ルールです。ストーリー US2.1、US2.9、US3.1、US3.2、US5.4 の受入条件（AC）を、実行できる規則にしました。規則の番号は `BR{グループ}.{連番}` で、U1〜U3（グループ 1〜14）に続けて、次のグループを使います: 15 観察者、16 小売店の需要、17 復帰用 token、18 試行回数の制限、19 サーバー側の権限、20 復元。

出典: `requirements.md`（FR2.3、FR4.1〜FR4.3、FR12、NFR5、NFR6）、`stories.md`、`entities.md`、`contract-summary.md`、`functional-design-questions.md`（Q1 観察者は在庫と受注残の合計まで、Q2 参加画面に入口、Q3 全要求で延長し書き込みは 1 分に 1 回、Q4 無効な token は同じ文言、Q5 参加の無効な試行だけ、Q6 移動窓、Q7 復元の仕組みは足さない、Q8 下書きは保存しない、Q9 構造と試験で強制、Q10 token は作り直さない）。

仮の数値（24 時間、10 回、60 秒、1 分）は設定値として持ち、NFR 要件の工程で確定します。

## 規則（YAML が正本）

```yaml
rules:
  - id: BR15.1
    statement: 観察者用コードを、観察者の資格情報として受け付ける。コードは進行役用コードと同じ強度（暗号論的乱数による 128 ビット以上）で作る
    category: authorization
    applies_to: [AccessControl.authenticate]
    trigger: 観察者用コードを付けた要求
    logic: IF 資格情報が、そのゲームの kind が observer のコードに一致し、revokedAt が空である THEN 呼び出した人を観察者（kind observer）として特定する。別のゲームのコードは認めない。コードの有効期間は、ゲームが削除されるまでで、期限は付けない。強度が 128 ビット以上のため総当たりは現実的でなく、観察者用コードの無効な試行は数えない（BR18.1）。revokedAt は U4 では設定しない（失効の操作は設けない）ため、実際にはゲームの削除まで有効である
    violation: 一致しないコードは拒否する（403 forbidden）
    source: FR4.3
  - id: BR15.2
    statement: 観察者は、書き込みの操作をすべて拒否される
    category: authorization
    applies_to: [入力, 代理入力, 週の確定, 一時停止, 再開, 終了, 担当者の入れ替え, 役割の割当て, 開始, 履歴の取得]
    trigger: 観察者の資格情報による書き込みまたは進行役専用の要求
    logic: IF 呼び出した人が観察者 THEN 状態の取得を除くすべての要求を拒否する。状態は変わらない
    violation: 拒否する（403 forbidden）
    source: FR4.3
  - id: BR15.3
    statement: 観察者の投影は、チーム全体の集計値と現在週だけを含む
    category: constraint
    applies_to: [ObserverView]
    trigger: 観察者による状態の取得
    logic: IF 呼び出した人が観察者 THEN currentWeek、status、入力済みの役割の数、4 役割の当週費用の合計、累積費用の合計、週末在庫の合計、週末受注残の合計だけを返す。費用・在庫・受注残の合計は、最新の確定済みの週の週末の値である（currentWeek の週ではない）。確定済みの週がまだないときは、初期状態の合計（費用は 0）を返す。役割別の値、意思決定値、受注、出荷、将来の需要、参加者の表示名、コードと token は返さない
    violation: 含めてはならない値が応答にあれば、投影の誤りとして試験が失敗する
    source: FR4.3
  - id: BR15.4
    statement: 観察者は、参加画面の入口からコードを入力して入り、コードはブラウザに保存して以後の要求に付ける
    category: policy
    applies_to: [観察者の入口]
    trigger: 観察者として見る操作
    logic: IF 入力されたコードが有効 THEN 観察画面を開き、コードをブラウザに保存する。IF 無効 THEN 画面に理由を示す。コードを URL に含めない
    violation: 無効なコードは拒否する（403 forbidden）。回数は数えない（BR18.1）
    source: FR4.3
  - id: BR16.1
    statement: 小売店の参加者だけが、当週までの顧客需要を見られる
    category: constraint
    applies_to: [小売店の投影]
    trigger: 小売店の参加者による状態の取得
    logic: IF 呼び出した人が小売店の参加者 かつ status が running、paused、ended のいずれか THEN 第 1 週から currentWeek までの顧客需要を返す（当週の値を含む。FR4.2）。currentWeek より後の週の値は返さない。IF status が preparing THEN 顧客需要を返さない（第 1 週はまだ始まっていない）
    violation: 将来の需要が応答にあれば、投影の誤りとして試験が失敗する
    source: FR4.2
  - id: BR16.2
    statement: 小売店以外の参加者には、顧客需要を取得させない。顧客需要の専用の経路は設けず、状態の投影の項目としてだけ返す
    category: authorization
    applies_to: [顧客需要の取得, 小売店以外の投影]
    trigger: 小売店以外の参加者による、顧客需要を取得する要求
    logic: 顧客需要は GET /games/{gameId}/state の投影の項目であり、専用の経路はない（契約 C1 のとおり）。IF 呼び出した人が小売店以外の参加者または観察者 THEN 投影に顧客需要の項目を含めない。IF 将来、顧客需要を直接取得する経路を足す THEN 小売店の参加者と進行役以外を拒否する。IF 資格情報なし、または他のゲームの資格情報 THEN 状態の取得自体を拒否する。進行役は設定として知っているため、進行管理の投影で見られる（U3）
    violation: 項目を含めない。資格情報のない要求は拒否する（403 forbidden）
    source: FR4.2
  - id: BR17.1
    statement: 復帰用 token は、最後の操作から有効期間（既定 24 時間、仮の値）を過ぎたら無効にする
    category: constraint
    applies_to: [ReturnToken]
    trigger: 参加者の token による要求
    logic: IF 現在の時刻が lastUsedAt に有効期間を足した時刻を過ぎている THEN token を無効として扱う。行は変えない
    violation: 拒否する（403 forbidden）。BR17.3 の文言で案内する
    source: NFR5
  - id: BR17.2
    statement: 認証に成功したすべての要求を最後の操作として数えるが、lastUsedAt の書き込みは 1 分に 1 回までにする
    category: calculation
    applies_to: [ReturnToken.lastUsedAt]
    trigger: 有効な token による要求
    logic: IF 現在の時刻と lastUsedAt の差が 1 分以上 THEN lastUsedAt を現在の時刻にする。IF 1 分未満 THEN 書き込まない。期限の判定は、この間引きによる最大 1 分の誤差を許す。この書き込みは return_tokens の行だけを更新し、GameSession の集約の版（expectedVersion）の検査と履歴の対象にしない。書き込みの競合は、後の時刻を採用してよい
    violation: 該当なし（失敗しても要求自体は拒否しない。書き込みの失敗はログに出す）
    source: NFR5
  - id: BR17.3
    statement: 無効な token（期限切れ、入れ替えで失効、不明）は、理由を区別せず同じ文言で案内する
    category: policy
    applies_to: [無効な token の応答]
    trigger: 無効な参加者 token による要求
    logic: IF token が期限切れ、失効、または存在しない THEN 同じ応答を返す。理由に「この端末の参加情報は使えません」、直し方に「進行役に担当者の入れ替えを依頼してください」を示す。画面は保存した token を消し、参加画面に戻す
    violation: 該当なし（この応答自体が拒否である。403 forbidden）
    source: NFR5
  - id: BR17.4
    statement: 有効な token での再接続は、同じ参加者・同じ役割として復帰し、確定済みのデータと確定前の入力を保つ
    category: policy
    applies_to: [再接続]
    trigger: 有効な token による状態の取得
    logic: IF token が有効 THEN 同じ参加者の投影を返す。割当て、確定済みの週、確定前の入力（保存済み）は変えない。30 分の切断のあとも同じ
    violation: 該当なし
    source: FR2.3
  - id: BR17.5
    statement: token は再接続しても作り直さず、同じ token を使い続ける。同じ token を複数のタブで使っても、同じ参加者として扱う
    category: policy
    applies_to: [ReturnToken]
    trigger: 再接続
    logic: IF 再接続 THEN 新しい token を発行せず、lastUsedAt だけを延ばす。token の失効は、進行役の入れ替え（U3 の BR10.2）だけで起きる
    violation: 該当なし
    source: FR12.2
  - id: BR17.6
    statement: 進行役による入れ替えで発行された新しい token は、発行の時刻から有効期間を数える
    category: calculation
    applies_to: [ReturnToken]
    trigger: 担当者の入れ替え（U3）
    logic: IF 新しい token を発行する THEN lastUsedAt を発行の時刻にする。以前の担当者の token は失効する（U3）。新しい token で同じ役割に戻れる
    violation: 該当なし
    source: FR12.2
  - id: BR18.1
    statement: 試行回数の制限が数えるのは、参加コードによる参加の試行のうち、無効だったもの、および拒否中に届いたものである
    category: constraint
    applies_to: [JoinAttemptWindow]
    trigger: 参加の要求
    logic: 参加の要求は、次の順で扱う。（1）接続元の窓から 60 秒より古い時刻を捨てる。（2）窓の件数が 10 以上なら、コードを検証せず拒否し（BR18.2）、この試行の時刻を窓に加える。（3）10 未満なら、コードを検証する。無効なら時刻を窓に加えて通常の拒否を返し、有効なら数えずに参加を進める。無効な token、進行役用コード、観察者用コードによる要求は、403 を返すだけで数えない（観察者用コードと進行役用コードは 128 ビット以上で総当たりが現実的でないため）
    violation: 該当なし
    source: NFR6
  - id: BR18.2
    statement: 同じ接続元の無効な試行が、直近 60 秒で 10 回を超えたら、一時的に拒否する
    category: constraint
    applies_to: [JoinAttemptWindow]
    trigger: 参加の要求
    logic: IF 試行の到着時に、同じ接続元の窓（直近 60 秒）にすでに 10 件ある（つまりこれが 11 件目）THEN 拒否する。窓は移動窓。拒否された試行も窓に加わるため、拒否中に試行を続けると解除が延びる（Q6 の決定。短時間に連打しても突破できない代わりに、待てば解除される）。60 秒間試行しなければ、自動で解除される
    violation: 拒否する（429 rate_limited）。参加の可否は判定しない（有効なコードでも、拒否中は参加できない）。hint に「しばらく待ってからやり直してください」を示す。境界の例: Given 同じ接続元が 60 秒以内に無効なコードで 9 回試行した / When 10 回目も無効 / Then 403 で拒否し、窓は 10 件になる。Given 窓が 10 件 / When 11 回目が無効なコード / Then 429。Given 窓が 10 件 / When 11 回目が有効なコード / Then 429（参加できない）。Given 最後の試行から 60 秒経った / When 有効なコードで参加 / Then 参加できる。この拒否の継続と NAT の共有は、Q6 で選んだ方式の受け入れたトレードオフで、10 回と 60 秒の見直しは NFR 要件の工程で行う
    source: NFR6
  - id: BR18.3
    statement: 接続元は、信頼するプロキシの設定に従って特定し、利用者が付けた値をそのまま信じない
    category: validation
    applies_to: [接続元の特定]
    trigger: 参加の要求
    logic: IF プロキシを信頼する設定がある THEN 設定した段数に従って転送元の情報から接続元を得る。IF ない THEN 接続の相手のアドレスを使う。利用者が任意に付けられるヘッダで、窓を回避させない。ロードバランサー（ALB など）の背後で動かすときは、信頼する段数を必ず設定する（設定しないと全員が 1 つの接続元になり、他人の誤入力で参加できなくなる）。この設定はデプロイの前提として、インフラの設計と NFR 設計の工程で確定する。教室など同じ NAT の背後にいる人は同じ接続元になり得る。これは仮の値（10 回）と合わせて NFR 要件の工程で見直す、受け入れたトレードオフである
    violation: 特定できない場合は、接続の相手のアドレスを使う
    source: NFR6
  - id: BR19.1
    statement: すべての要求で、資格情報の種類と、ゲーム・役割への権限をサーバー側で検証する
    category: authorization
    applies_to: [すべての入口]
    trigger: すべての要求
    logic: IF 資格情報が、要求のゲームのものでない、または要求の役割の担当者のものでない THEN 拒否する。他のゲームの役割の識別子は、そのゲームのコードや token では通らない。画面で隠すだけにしない。検査の順は、資格情報の特定、ゲーム・役割への権限、入力の検証（422）、状態の検査（409）の順で、認可を必ず先に行う。そのため、権限のない人には 422 や 409 の違いで、ゲームや役割の存在・状態が分からない
    violation: 拒否する（403 forbidden）。ゲームや役割の存在を、応答の違いで明かさない
    source: NFR6
  - id: BR19.2
    statement: HTTP の入口は、GameSession を直接 import できず、AccessControl 経由でだけ GameSession を呼ぶ
    category: constraint
    applies_to: [モジュールの境界]
    trigger: 変更の検査（lint、構造試験）
    logic: IF HTTP の入口のモジュールが GameSession を直接 import する THEN lint と構造の自動試験が失敗する。外へ出る経路は AccessControl に限る
    violation: 検査の失敗として、マージを止める
    source: NFR6
  - id: BR19.3
    statement: 全ての経路について、無資格、別のゲーム、別の役割、観察者で拒否されることを網羅する試験を置く
    category: constraint
    applies_to: [入口の一覧]
    trigger: 変更の検査（自動試験）
    logic: IF 入口が追加される THEN 網羅試験の対象の表に加わらない限り、試験が失敗する。表の各行は、期待する拒否（403）を持つ
    violation: 検査の失敗として、マージを止める
    source: NFR6
  - id: BR20.1
    statement: 復元のための新しい仕組みは足さない。保存済みの集約を読み直すことが復元である
    category: policy
    applies_to: [GameSession.load]
    trigger: サービスの再起動
    logic: IF サービスが再起動する THEN 状態を PostgreSQL から読み直し、確定済みの週から続ける。進行役の復元の操作や起動時の検査は設けない
    violation: 該当なし
    source: FR12.1
  - id: BR20.2
    statement: 再起動の前後で、確定済みの週の状態、確定前の入力、割当て、token、冪等の記録が一致する
    category: constraint
    applies_to: [永続状態]
    trigger: 再起動を含む試験
    logic: IF 第 10 週まで確定したゲームが再起動する THEN 第 10 週の状態（在庫、受注残、遅延、履歴、費用）が一致し、第 11 週から続けられる。IF 第 5 週で小売店が 10 を入力済みで未確定 THEN 再起動後も 10 のまま残る。再起動の前に成功した識別子の再送は、前回と同じ結果を返す
    violation: 一致しなければ試験が失敗する
    source: FR12.1
  - id: BR20.3
    statement: 画面は、状態の取り直しに失敗している間は接続が切れていることを示して取り直しを続け、送信に失敗した入力は欄に残し、ブラウザには保存しない
    category: policy
    applies_to: [画面]
    trigger: 状態の取り直しまたは送信の失敗
    logic: IF 取り直しに失敗 THEN 「接続が切れています。自動で再接続を試みます」と示し、取り直しを続ける。IF 入力の送信に失敗 THEN 失敗を示し、入力欄の値は残す。送信前の値をブラウザの保存に書かない
    violation: 該当なし
    source: FR12.2
```

## 規則の一覧

| ID | 内容 | 種別 | 根拠 |
| :--- | :--- | :--- | :--- |
| BR15.1 | 観察者用コードを資格情報として受け付ける | authorization | FR4.3 |
| BR15.2 | 観察者の書き込みを拒否 | authorization | FR4.3 |
| BR15.3 | 観察者の投影はチーム全体の値だけ | constraint | FR4.3 |
| BR15.4 | 参加画面の入口から入る | policy | FR4.3 |
| BR16.1 | 小売店だけが当週までの需要 | constraint | FR4.2 |
| BR16.2 | 他者には需要を取得させない | authorization | FR4.2 |
| BR17.1 | token は最後の操作から 24 時間 | constraint | NFR5 |
| BR17.2 | 全要求で延長、書き込みは 1 分に 1 回 | calculation | NFR5 |
| BR17.3 | 無効な token は同じ文言 | policy | NFR5 |
| BR17.4 | 再接続は同じ参加者・役割で復帰 | policy | FR2.3 |
| BR17.5 | token は作り直さない | policy | FR12.2 |
| BR17.6 | 入れ替えの新 token は発行時から数える | calculation | FR12.2 |
| BR18.1 | 数えるのは参加の無効な試行だけ | constraint | NFR6 |
| BR18.2 | 直近 60 秒で 10 回を超えたら拒否 | constraint | NFR6 |
| BR18.3 | 接続元は信頼するプロキシの設定で特定 | validation | NFR6 |
| BR19.1 | サーバー側で毎回検証 | authorization | NFR6 |
| BR19.2 | GameSession の直接 import を禁止 | constraint | NFR6 |
| BR19.3 | 全経路の拒否の網羅試験 | constraint | NFR6 |
| BR20.1 | 復元の新しい仕組みは足さない | policy | FR12.1 |
| BR20.2 | 再起動の前後で一致 | constraint | FR12.1 |
| BR20.3 | 切断中の画面の扱い | policy | FR12.2 |

## 上流の資料

`requirements.md`、`stories.md`、`entities.md`、`contract-summary.md`、`functional-design-questions.md`
