/**
 * ローカルで起動中の API（共有の契約 /api/v1）に対し、作成 → 参加 → 割り当て → 開始 → 入力 → 確定 → 状態の確認を通す。
 * 使い方: npm run smoke（API_URL、ORIGIN で接続先を変えられる）
 */
import { randomUUID } from 'node:crypto';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5173';
const ROLES = ['FACTORY', 'DISTRIBUTOR', 'WHOLESALER', 'RETAILER'] as const;
const API = '/api/v1';

class Client {
  private session = '';
  /** 直近の応答の Location（作成の応答が、新しいゲームの場所を返す） */
  location = '';

  async call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.session ? { cookie: `bg_session=${this.session}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(';');
      if (pair?.startsWith('bg_session=')) this.session = pair.slice(11);
    }
    this.location = res.headers.get('location') ?? '';
    const data = await res.json().catch(() => null);
    if (!res.ok)
      throw new Error(
        `${method} ${path} -> ${res.status} ${JSON.stringify(data)}`,
      );
    return data;
  }
}

async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
  const result = await work();
  console.log(`✓ ${name}`);
  return result;
}

async function main() {
  const probe = new Client();
  await step('/health が 200', () => probe.call('GET', '/health'));
  await step('/ready が 200（DB に接続できる）', () =>
    probe.call('GET', '/ready'),
  );
  await step(`${API}/ready が 200（DB と通知の受信）`, () =>
    probe.call('GET', `${API}/ready`),
  );

  const fac = new Client();
  await step('ゲームを作成', () =>
    fac.call('POST', `${API}/games`, {
      kind: 'KIT',
      finalWeek: 2,
      demand: [4, 4],
    }),
  );
  const gameId = fac.location.split('/')[4]!;
  const { joinCode } = await fac.call('GET', `${API}/games/${gameId}/state`);

  const players: Client[] = [];
  for (const role of ROLES) {
    const p = new Client();
    await p.call('POST', `${API}/participations/join`, {
      joinCode,
      displayName: role,
    });
    const lobby = await fac.call('GET', `${API}/games/${gameId}/lobby`);
    const joined = (
      lobby.participants as { participantId: string; displayName: string }[]
    ).find((x) => x.displayName === role);
    await fac.call(
      'PUT',
      `${API}/games/${gameId}/participants/${joined!.participantId}/role`,
      { role },
    );
    players.push(p);
  }
  console.log('✓ 4 人が参加し、役割を割り当て');

  await step('ゲームを開始', () =>
    fac.call('POST', `${API}/games/${gameId}/start`),
  );

  const retailer = await players[3]!.call(
    'GET',
    `${API}/sessions/${gameId}/state`,
  );
  if (retailer.roleStatus.customerDemand === undefined)
    throw new Error('小売店に顧客需要が表示されない');
  const factory = await players[0]!.call(
    'GET',
    `${API}/sessions/${gameId}/state`,
  );
  if ('customerDemand' in factory.roleStatus)
    throw new Error('工場に顧客需要が開示されている');
  console.log('✓ 顧客需要は小売店だけに開示');

  for (const p of players) {
    await p.call(
      'PUT',
      `${API}/sessions/${gameId}/decisions`,
      { week: 1, quantity: 4 },
      { 'if-match': '"0"' },
    );
  }
  console.log('✓ 4 役割が発注を保存');

  await step('1 週目を確定', () =>
    fac.call('POST', `${API}/sessions/${gameId}/weeks/1/commit`, {
      requestedWeek: 1,
      basis: { FACTORY: 1, DISTRIBUTOR: 1, WHOLESALER: 1, RETAILER: 1 },
    }),
  );

  const after = await players[3]!.call(
    'GET',
    `${API}/sessions/${gameId}/state`,
  );
  if (after.week !== 2) throw new Error('確定後に週が進んでいない');
  const state = await fac.call('GET', `${API}/sessions/${gameId}/state`);
  if (state.results.length !== 4)
    throw new Error('確定後の役割別の結果が正しくない');
  console.log('✓ 確定後、2 週目に進み、役割別の結果が載る');
  console.log('\nローカルの動作確認: OK');
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
