// ローカル開発用: 参加コードを指定して、ボット参加者を API 経由で参加させる。
// 使い方: npm run dev:bots -- <参加コード> [人数(既定 4)]
const [joinCode, count = '4'] = process.argv.slice(2);
if (!joinCode) {
  console.error('使い方: npm run dev:bots -- <参加コード> [人数]');
  process.exit(1);
}
const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
const origin = process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173';

for (let index = 1; index <= Number(count); index++) {
  const response = await fetch(`${apiUrl}/api/v1/participations/join`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({ joinCode, displayName: `ボット${index}` }),
  });
  if (!response.ok) {
    console.error(
      `ボット${index} の参加に失敗しました: ${response.status} ${await response.text()}`,
    );
    process.exit(1);
  }
  console.log(`ボット${index} が参加しました`);
}
