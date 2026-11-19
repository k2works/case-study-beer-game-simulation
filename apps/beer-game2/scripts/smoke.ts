/**
 * ローカルで起動中の API に対し、作成 → 参加 → 割り当て → 開始 → 入力 → 確定 → 状態の確認を通す。
 * 使い方: npm run smoke（API_URL、ORIGIN で接続先を変えられる）
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5173';
const ROLES = ['FACTORY', 'DISTRIBUTOR', 'WHOLESALER', 'RETAILER'] as const;

/** 認証つきで SSE に接続し、'changed' イベントを待つ */
async function openStream(client: Client, gameId: string) {
  const ctrl = new AbortController();
  const res = await client.raw(`/api/games/${gameId}/stream`, ctrl.signal);
  if (res.status !== 200) throw new Error(`SSE に接続できない (${res.status})`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const pending = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += decoder.decode(value);
    }
  })().catch(() => {});
  return {
    async changed(timeoutMs: number) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (text.includes('event: changed')) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    },
    close() {
      ctrl.abort();
      void pending;
    },
  };
}

class Client {
  private cookie = '';
  async raw(path: string, signal?: AbortSignal) {
    return fetch(`${API_URL}${path}`, {
      headers: {
        origin: ORIGIN,
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      ...(signal ? { signal } : {}),
    });
  }

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
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const data = res.status === 204 ? null : await res.json().catch(() => null);
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

  const fac = new Client();
  const created = await step('ゲームを作成', () =>
    fac.call('POST', '/api/games', { weeks: 2 }),
  );
  const gameId = created.gameId as string;

  const players: Client[] = [];
  for (const role of ROLES) {
    const p = new Client();
    const joined = await p.call('POST', '/api/join', {
      joinCode: created.joinCode,
      displayName: role,
    });
    await fac.call('POST', `/api/games/${gameId}/assignments`, {
      participantId: joined.participantId,
      role,
    });
    players.push(p);
  }
  console.log('✓ 4 人が参加し、役割を割り当て');

  await step('ゲームを開始', () =>
    fac.call('POST', `/api/games/${gameId}/start`, {}),
  );

  const retailer = await players[3]!.call('GET', `/api/games/${gameId}/me`);
  if (retailer.customerDemand === undefined)
    throw new Error('小売店に顧客需要が表示されない');
  const factory = await players[0]!.call('GET', `/api/games/${gameId}/me`);
  if ('customerDemand' in factory)
    throw new Error('工場に顧客需要が開示されている');
  console.log('✓ 顧客需要は小売店だけに開示');

  // SSE: 変化の通知が届く（CloudFront / ALB 越しでも維持されることの確認にも使う）
  const sse = await openStream(players[3]!, gameId);
  console.log('✓ SSE に接続');

  for (const [i, role] of ROLES.entries()) {
    await players[i]!.call(
      'PUT',
      `/api/games/${gameId}/decision`,
      { role, quantity: 4 },
      { 'if-match': '"0"' },
    );
  }
  console.log('✓ 4 役割が発注を保存');

  if (!(await sse.changed(5000))) throw new Error('SSE の通知が届かない');
  sse.close();
  console.log('✓ SSE の通知を受信（内容は含まない）');

  const con = await fac.call('GET', `/api/games/${gameId}/console`);
  const commit = await step('1 週目を確定', () =>
    fac.call(
      'POST',
      `/api/games/${gameId}/commit`,
      { week: 1 },
      {
        'if-match': `"${con.sessionVersion}"`,
        'idempotency-key': `smoke-${Date.now()}`,
      },
    ),
  );
  if (commit.nextWeek !== 2)
    throw new Error(`週が進んでいない: ${JSON.stringify(commit)}`);

  const after = await players[3]!.call('GET', `/api/games/${gameId}/me`);
  if (after.history.length !== 1 || after.week !== 2)
    throw new Error('確定後の状態が正しくない');
  console.log('✓ 確定後、2 週目に進み、役割別の結果が履歴に載る');
  console.log('\nローカルの動作確認: OK');
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
