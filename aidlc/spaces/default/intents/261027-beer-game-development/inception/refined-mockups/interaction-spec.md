# Interaction Specification

## Global interaction rules

- すべての状態変更は明示的な button 操作で開始し、focus や field 入力だけでは実行しません。
- field error は対象 field と error summary の両方に text で表示し、入力値を保持します。
- async 更新は `aria-live="polite"` で通知し、緊急な権限・保存失敗は `role="alert"` を使います。
- server から受けた version が画面の version より新しい場合、古い応答を適用せず stale state を表示します。

## Component specifications

### WeekProgress

- **Purpose**: 12 ステップの現在地と完了済み範囲を示します。
- **Anatomy**: ordered list、step label、current marker、status text。
- **States**: upcoming、current、complete、blocked、paused。
- **Keyboard**: 読取り専用。補足を展開する場合のみ button として Enter / Space に対応します。
- **Accessibility**: `aria-current="step"`、色に加えて icon と text を使用します。

### RoleDecisionForm

- **Purpose**: 発注数または生産要請数を入力し、役割の意思決定を確定します。
- **States**: pristine、dirty、invalid、submitting、submitted、conflict、read-only。
- **Validation**: required、integer、0 以上、Domain Design で定める上限以下。
- **Conflict**: server version と競合した場合は相手の最新値と自分の未保存値を並べ、上書きせず再入力を促します。
- **Accessibility**: native number input に依存せず text input + `inputmode="numeric"` と server validation を併用します。

### RoleStatusList

- **Purpose**: 4 役割の割当てと入力完了を表示します。
- **States**: unassigned、assigned、ready、pending、submitted、disconnected。
- **Privacy**: 参加者画面では意思決定値を表示せず、進行役画面でのみ権限に応じて表示します。

### ConfirmWeekDialog

- **Trigger**: 4 役割が submitted のときだけ有効です。
- **Content**: 対象週、役割別入力、不可逆性、実行される計算の要約。
- **Keyboard**: open 時に heading へ focus、focus trap、Escape で cancel、close 後は trigger に focus を戻します。
- **Failure**: dialog を閉じず error と correlation ID を表示し、再試行を許可します。

### TimeSeriesComparison

- **Purpose**: 終了後の Bullwhip Effect を比較します。
- **Alternatives**: chart と同じ値を持つ table view を常設します。
- **Keyboard**: legend toggle は button、series 選択は checkbox group とします。
- **Accessibility**: pattern、直接 label、text summary を使い、色だけに依存しません。

## Primary flows

### Game creation

1. 進行役が設定を入力します。
2. client-side validation は即時の補助として動き、server validation を正とします。
3. 成功時は参加コードへ focus を移し、copy action を提供します。
4. 失敗時は同じ画面に留まり、値を保持して error summary を表示します。

### Weekly decision and commit

1. 各役割が自役割の許可済み情報を確認します。
2. 発注数または生産要請数を入力し、確定します。
3. 進行役は RoleStatusList で 4 役割の完了を確認します。
4. ConfirmWeekDialog で入力と影響を確認し、週確定を実行します。
5. 成功時は新しい週と状態を 2 秒以内に表示し、screen reader に通知します。
6. duplicate、stale、failure は二重計上せず、最新状態または再試行 action を示します。

### Pause, recovery, and end

- pause は理由を任意入力して全員へ通知し、新規確定を disabled にします。
- reconnect は browser の復帰 token で同じ役割へ戻り、最新の確定済み状態を表示します。
- end は専用確認 dialog で行い、終了後は入力を拒否して Review への導線を表示します。

## Sources

- `mockups.md`
- `stories.md` の US1.1〜US5.1
- `requirements.md` の FR1〜FR8、NFR1〜NFR7

## Assumptions & Open Questions

- real-time transport は未決定です。interaction は polling、SSE、WebSocket のいずれでも同じ利用者向け状態を満たす必要があります。

