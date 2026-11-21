// 合成監視（CloudWatch Synthetics）。/api/v1/ready を取得し、2xx 以外なら失敗にする。
// 業務の操作（作成・参加・確定）は呼ばない（本番にゲームが溜まるため）。業務の操作の監視は、アプリのメトリクスが担う。
// AWS 上での動作は未確認（適用の前に、ランタイムの版とモジュール名を確かめる）。
const synthetics = require('Synthetics');

const checkReady = async function () {
  const requestOptions = {
    hostname: process.env.TARGET_HOST,
    method: 'GET',
    path: '/api/v1/ready',
    port: 443,
    protocol: 'https:',
  };
  const callback = async function (res) {
    return new Promise((resolve, reject) => {
      if (res.statusCode < 200 || res.statusCode > 299) {
        reject(new Error(`ready が ${res.statusCode} を返した`));
        return;
      }
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
  };
  await synthetics.executeHttpStep('ready', requestOptions, callback);
};

exports.handler = async () => {
  return await checkReady();
};
