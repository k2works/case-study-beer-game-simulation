// ローカル開発用: ボット参加者の参加と、ゲームのオートプレイ。
// dev 中は vite.config.ts がゲーム作成を検知して joinBots → autoplay を自動で呼ぶ。
// 手動で参加だけさせる場合: npm run dev:bots -- <参加コード> [人数(既定 4)]
import { fileURLToPath } from 'node:url';

const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
const origin = process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173';
const tickMs = Number(process.env.AUTOPLAY_TICK_MS ?? 1000);

interface Bot {
  sessionId: string;
  cookie: string;
}
interface BotState {
  week: number;
  status: string;
  version: number;
  decisionComplete: boolean;
  decisionVersion: number;
  own: { order: number };
}

const cookieHeader = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');

const call = (
  method: string,
  path: string,
  cookie: string,
  options: { body?: unknown; ifMatch?: number } = {},
) =>
  fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers: {
      origin,
      cookie,
      'idempotency-key': crypto.randomUUID(),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.ifMatch !== undefined ? { 'if-match': String(options.ifMatch) } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

export async function joinBots(joinCode: string, count = 4): Promise<Bot[]> {
  const bots: Bot[] = [];
  for (let index = 1; index <= count; index++) {
    const response = await fetch(`${apiUrl}/api/v1/participations/join`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({ joinCode, displayName: `ボット${index}` }),
    });
    if (!response.ok)
      throw new Error(
        `ボット${index} の参加に失敗しました: ${response.status} ${await response.text()}`,
      );
    const { sessionId } = (await response.json()) as { sessionId: string };
    bots.push({ sessionId, cookie: cookieHeader(response) });
    console.log(`ボット${index} が参加しました`);
  }
  return bots;
}

// 役割の割り当てと開始（主催者の操作）を待ち、ACTIVE の間は毎週
// 「受けた注文と同数を発注」して、主催者の権限で週を確定する。
export async function autoplay(bots: Bot[], facilitatorCookie: string, maxMinutes = 30) {
  const deadline = Date.now() + maxMinutes * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, tickMs));
    const responses = await Promise.all(
      bots.map((bot) => call('GET', `/sessions/${bot.sessionId}/state`, bot.cookie)),
    );
    if (responses.some((response) => !response.ok)) continue; // 役割の割り当て待ち
    const states = (await Promise.all(responses.map((response) => response.json()))) as BotState[];
    if (states[0].status === 'ENDED') return console.log('オートプレイが完了しました');
    if (states[0].status !== 'ACTIVE') continue; // 開始待ち
    await Promise.all(
      states.map((state, index) =>
        state.decisionComplete
          ? undefined
          : call('PUT', `/sessions/${bots[index].sessionId}/decisions`, bots[index].cookie, {
              body: { quantity: state.own.order },
              ifMatch: state.decisionVersion,
            }),
      ),
    );
    const commit = await call(
      'POST',
      `/sessions/${bots[0].sessionId}/weeks/${states[0].week}/commit`,
      facilitatorCookie,
      { ifMatch: states[0].version },
    );
    if (!commit.ok)
      console.error(`週の確定に失敗しました: ${commit.status} ${await commit.text()}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [joinCode, count = '4'] = process.argv.slice(2);
  if (!joinCode) {
    console.error('使い方: npm run dev:bots -- <参加コード> [人数]');
    process.exit(1);
  }
  await joinBots(joinCode, Number(count)).catch((error: unknown) => {
    console.error(String(error));
    process.exit(1);
  });
}
