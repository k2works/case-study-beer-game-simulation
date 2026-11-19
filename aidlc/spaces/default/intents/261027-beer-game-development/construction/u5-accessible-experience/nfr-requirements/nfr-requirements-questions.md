# U5 NFR Requirements 質問

既決定の 15 チーム同時利用、週確定後 2 秒以内の画面反映、WCAG 2.2 AA、desktop browser 最新 2 世代、SSE と 1 秒 polling fallback を前提にします。

## Q1. [品質担当] screen reader の受入試験の組合せ

Chrome、Edge、Firefox、Safari の keyboard 操作は全て確認します。主要 flow の screen reader 手動試験をどの組合せで必須にしますか。

- A. Windows の NVDA + Chrome と macOS の VoiceOver + Safari を必須にし、残る browser は keyboard と自動検査で確認する
- B. Windows の NVDA + Chrome / Firefox と macOS の VoiceOver + Safari を必須にし、残る browser は keyboard と自動検査で確認する
- C. 4 browser すべてで対応する screen reader を使った主要 flow の手動試験を必須にする
- X. Other (please specify)

[Answer]: A. Windows の NVDA + Chrome と macOS の VoiceOver + Safari を必須にし、残る browser は keyboard と自動検査で確認する

## Q2. [品質担当] 自動更新が切れたときの画面反映目標

通常の週確定後の画面反映は 2 秒以内と決まっています。SSE が切れ、選択済みの 1 秒 polling に切り替わった場合の受入上限を決めます。

- A. 4 秒以内。U1 の既存 fallback 目標を維持する
- B. 2 秒以内。通常時と同じ上限を fallback にも適用する
- X. Other (please specify)

[Answer]: A. 4 秒以内。U1 の既存 fallback 目標を維持する
