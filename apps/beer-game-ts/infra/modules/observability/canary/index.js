// 合成監視: 1 分ごとに /ready を叩き、200 でなければ失敗にする（研修中の停止を 1 分以内に検知する）
const log = require('SyntheticsLogger');

exports.handler = async () => {
  const url = process.env.TARGET_URL;
  const response = await fetch(url);
  log.info(`GET ${url} -> ${response.status}`);
  if (response.status !== 200) throw new Error(`ready が ${response.status} を返しました`);
  return 'ok';
};
