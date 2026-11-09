# Performance Design - u5-accessible-experience

## Browser update path

U5 は HTTP command の結果を authoritative な version として採用し、SSE は新しい version の通知に使います。event の本文に private state を含めず、通知後に role-safe snapshot を取得します。切断時は表示中だけ 1 秒間隔で polling し、利用者が自動更新を停止した場合は request を止め、手動更新を残します。再接続時は最新 snapshot を一度取得し、version を比較して欠落を補います。古い response は破棄し、未保存 draft は別 state として保持します。

| 対象 | 設計 | 検証 |
|---|---|---|
| NFR1.11 | commit 時刻から SSE 通知、role-safe snapshot、React 描画までを correlation ID と game/version で関連付ける。通知遅延を 500 ms、snapshot と描画を合わせて残り 1.5 秒以内の初期予算とし、全体 p95 2 秒を正本とする。 | 75 接続、50 週データで commit-to-render histogram を計測する。 |
| NFR1.12 | SSE 切断を検知したら 1 秒 polling に切り替える。切断表示と復旧表示を出し、polling 中の同時 request は 1 本に制限する。 | SSE 遮断中に commit し、画面到達 4 秒以内を測る。 |
| NFR1.13 | 自動更新停止は page state に保持し、停止中の SSE 再接続と polling を行わない。手動更新は current version を照会する。 | 停止中の network request が 0 であることを確認する。 |
| NFR1.14 | server version が現表示より大きい場合だけ表示 state を置き換える。draft と conflict marker は別に保持する。 | 逆順 response、timeout、再接続、複数 tab で検証する。 |

## Input latency budget

NFR1.10 の p95 1 秒は、入力確定 button の activation から成功状態の React 描画までを 75 user 負荷で測ります。初期の各 request の設計予算は server 700 ms、network 200 ms、client render 100 ms です。server の 700 ms は U1 の 1 秒上限より厳しい運用目標として扱います。p95 の部分値を足して全体 p95 と見なさず、同一操作の end-to-end histogram と各 span を同時に計測します。

server が 700 ms を超える時は、validation、authorization、transaction、serialization の span を確認します。network が 200 ms を超える時は payload size、connection reuse、地理的距離を確認します。render が 100 ms を超える時は state 更新範囲と chart 再描画を確認します。予算の配分は実測で調整できますが、全体の p95 1 秒は維持します。

## Resource use

- polling snapshot は role-safe current state のみを返し、履歴 chart は終了後の画面で別途取得します。最大 75 request/秒の fallback 負荷を server 容量試験に含めます。
- 同一 version の重複通知を統合し、未表示 tab では更新を停止して復帰時に一度だけ照会します。利用者の自動更新停止の選択を優先します。
- chart と table は 50 週分を同時に扱い、入力操作を阻害しないことを browser profile で確認します。数値は table を正本として同じ series model から描画します。

## Provider contract needed

共有 C1 / C6 には SSE URL、event version、認可、再接続方法、polling snapshot がありません。U1 / U3 が provider として契約を定義し、U5 が consumer test を固定するまでは SSE と 4 秒 fallback の受入判定を保留します。提案する event は `gameId`、`version`、`eventId`、`correlationId` の非公開値を含まない通知とし、snapshot は現在 version と role-safe state を返します。

## Sources

- `construction/u5-accessible-experience/nfr-requirements/performance-requirements.md`
- `construction/u5-accessible-experience/nfr-requirements/tech-stack-decisions.md`
- `construction/u5-accessible-experience/functional-design/functional-spec.md`
- `inception/contract-design/contract-summary.md` C1、C6
- `nfr-design-questions.md` Q1

## Assumptions & Open Questions

- SSE / polling の browser 向け契約は provider 承認待ちです。ここでの event field は提案であり、共有契約の正本ではありません。
