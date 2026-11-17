-- 103: 保持と削除の GRANT（PostgreSQL 専用。B11）。V006 の表のための権限。既定の権限は与えない。
-- ロールは 102 が作る。表の所有者は、マイグレーションを実行する接続のユーザー。

-- 書き込み（api）: retention_policies は GameCreated の投影（再構築が行を消すので DELETE も与える）。deletion_* には与えない。
GRANT SELECT, INSERT, UPDATE, DELETE ON retention_policies TO beergame_writer;

-- 読み取り（api の問い合わせ。S09 保持状態）: 方針と、削除の進行の状態だけ。受領記録・試行履歴は読めない。
GRANT SELECT ON retention_policies, deletion_runs TO beergame_reader;

-- 削除（retention モード）: 期限の検出（retention_policies の SELECT）、削除の進行の記録、受領記録の挿入と期限切れの掃除。
-- game_roots の SELECT・DELETE は 102。連鎖削除の子の表（events ほか）の DELETE 権限は、要らない（102 の注記）。
GRANT SELECT ON retention_policies TO beergame_deleter;
GRANT SELECT, INSERT, UPDATE, DELETE ON deletion_runs, deletion_attempts TO beergame_deleter;
GRANT SELECT, INSERT, DELETE ON deletion_receipts TO beergame_deleter;
