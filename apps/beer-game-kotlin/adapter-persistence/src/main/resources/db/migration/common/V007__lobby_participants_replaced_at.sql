-- 007: ロビーの参加者に、入れ替えられた時刻（replaced_at）を足す（B5 Step 3.5・5.5。拡張だけ。ロールバックしやすい）。
-- 開始後の役割の入れ替えで外れた旧担当者の行は消さず（履歴と入力者のラベルのため）、ParticipantReplaced の投影が、
-- role を NULL にして replaced_at に入れ替えの時刻を書く。NULL は「入れ替えられていない」。既存の行は NULL のまま。
-- 投影の形の変更なので、再構築（イベントからの導出）で埋められる。番号 006 は B11（保持）の予約として空けてある。

ALTER TABLE lobby_participants ADD COLUMN replaced_at timestamp with time zone;
