# Performance Requirements - u5-accessible-experience

## Targets

| ID | Requirement | Measurement |
|---|---|---|
| NFR1.10 | 15 game、各 game 4 participant と 1 facilitator の同時利用下で、入力確定から成功状態の表示までの p95 を 1 秒以内とする。server 側の NFR1.1 と同じ 75 user 負荷で測る。 | 操作開始、HTTP 完了、React 描画完了を同一 correlation ID で計測する。15 分の steady load、50 週相当の履歴を用いる。 |
| NFR1.11 | SSE 接続中は週確定の server commit から最新 version の画面表示までの p95 を 2 秒以内とする。 | commit timestamp と browser render timestamp の差を 75 接続の E2E 負荷試験で測る。 |
| NFR1.12 | SSE 切断時は 1 秒間隔で polling に移り、週確定から最新 version の表示まで 4 秒以内とする。再接続後は欠落 version を取得して収束する。 | SSE を遮断した browser E2E 試験で polling 間隔と反映時間を測る。 |
| NFR1.13 | 利用者が自動更新を停止した画面は自動 request を発行しない。手動更新で最新 version を取得できる。 | network request と画面状態の E2E 試験。 |
| NFR1.14 | stale response は現表示より古い version を上書きしない。通信失敗や再接続で未保存 draft を失わない。 | 応答順序を反転し、切断と競合を注入する component / E2E 試験。 |

## Resource Constraints

- polling は game / role scope の軽量 snapshot を取得し、歴史データや他 role の private data を毎秒再取得しません。15 game × 5 user の fallback 時は最大 75 request/秒を基準負荷として測ります。
- 非表示 tab は更新を減速または停止し、表示復帰時に最新 version を一度取得します。ただし、表示中の自動更新を利用者が停止した選択を勝手に解除しません。
- chart は同値 table を同時に利用可能にし、長い週次履歴でも入力欄と navigation の操作を妨げないことを 50 週のデータで確認します。

## Sources

- `inception/requirements-analysis/requirements.md` NFR1
- `inception/contract-design/contract-summary.md` C1、C6
- `construction/u1-walking-skeleton/nfr-requirements/performance-requirements.md` NFR1.1〜NFR1.4
- `construction/u5-accessible-experience/functional-design/functional-spec.md`
- `nfr-requirements-questions.md` Q2

## Assumptions & Open Questions

- SSE endpoint、event schema、再接続 cursor、polling snapshot の provider 契約は共有契約に未定義です。NFR Design と実装着手前の契約補完で確定します。
- 4 秒の fallback 上限は画面が表示中で自動更新を許可した場合の値です。利用者が停止した場合は手動更新が必要です。
