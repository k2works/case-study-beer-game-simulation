import { composeApplication, createPool } from './compose.js';
import { loadConfig } from './config/index.js';

/**
 * 保持の定期のタスク（EventBridge から 5 分ごとに起動する ECS タスク）。期限に達したゲームを削除して終了する。
 * 結果は構造化ログに残す。恒久的な失敗があれば、エラーとして記録し、終了コード 1 で終わる（通知は B11）。
 */
const config = loadConfig(process.env);
const pool = createPool(config);
try {
  const result = await composeApplication(config, pool).runRetention();
  const failed = result.permanentFailures > 0;
  console.log(
    JSON.stringify({
      level: failed ? 'error' : 'info',
      msg: failed
        ? '保持の削除で恒久的な失敗があります'
        : '保持の削除を実行しました',
      ...result,
    }),
  );
  process.exitCode = failed ? 1 : 0;
} finally {
  await pool.end();
}
