import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../src/application/index.js';
import { buildServer } from '../../src/adapters/http/server.js';
import { ROLES } from '../../src/domain/role.js';
import type { RateLimiter } from '../../src/ports/index.js';
import {
  fakeCredentials,
  memoryRateLimiter,
  memoryReviewReader,
  memoryUnitOfWork,
  sequentialIds,
} from '../support/memory.js';

const ORIGIN = 'https://beer.example.test';
let server: FastifyInstance;
let logs: string[];
let dbUp: boolean;
let mem: ReturnType<typeof memoryUnitOfWork>;

async function boot(
  rateLimiter: RateLimiter = memoryRateLimiter(1000, 60_000),
) {
  logs = [];
  dbUp = true;
  mem = memoryUnitOfWork();
  const app = createApplication({
    uow: mem.uow,
    clock: { now: () => new Date() },
    ids: sequentialIds(),
    credentials: fakeCredentials(),
    reviews: memoryReviewReader(mem),
  });
  server = buildServer({
    app,
    ready: async () => dbUp,
    notifier: { subscribe: () => () => {} },
    rateLimiter,
    config: { allowedOrigin: ORIGIN, logLevel: 'info' },
    logStream: new Writable({
      write(chunk, _enc, cb) {
        logs.push(String(chunk));
        cb();
      },
    }),
  });
  await server.ready();
}
beforeEach(() => boot());

const post = (
  url: string,
  payload: unknown,
  cookie?: string,
  headers: Record<string, string> = {},
) =>
  server.inject({
    method: 'POST',
    url,
    payload: payload as object,
    headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...headers },
  });
const get = (url: string, cookie?: string) =>
  server.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  `${res.cookies[0]!.name}=${res.cookies[0]!.value}`;

async function table() {
  const created = await post('/api/games', { weeks: 2 });
  const fac = cookieOf(created);
  const { gameId, joinCode } = created.json();
  const players: Record<string, string> = {};
  for (const role of ROLES) {
    const j = await post('/api/join', {
      joinCode,
      displayName: `秘密の名前-${role}`,
    });
    players[role] = cookieOf(j);
    await post(
      `/api/games/${gameId}/assignments`,
      { participantId: j.json().participantId, role },
      fac,
    );
  }
  await post(`/api/games/${gameId}/start`, {}, fac);
  return { gameId, fac, players };
}

describe('ルートと Cookie', () => {
  it('[US1.1/AC1.1.1] ゲームを作ると 201 で、進行役の Cookie が HttpOnly・Secure・SameSite=Strict で発行される', async () => {
    const res = await post('/api/games', { weeks: 3 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      gameId: expect.any(String),
      joinCode: expect.any(String),
    });
    const raw = String(res.headers['set-cookie']);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/SameSite=Strict/i);
  });

  it('[US1.2/AC1.2.1] 参加から開始、入力、確定、状態の取得まで通る', async () => {
    const { gameId, fac, players } = await table();
    const lobby = await get(`/api/games/${gameId}/lobby`, fac);
    expect(lobby.json()).toMatchObject({ status: 'STARTED' });
    for (const role of ROLES) {
      const r = await server.inject({
        method: 'PUT',
        url: `/api/games/${gameId}/decision`,
        payload: { role, quantity: 4 },
        headers: { origin: ORIGIN, cookie: players[role]!, 'if-match': '"0"' },
      });
      expect(r.statusCode).toBe(200);
    }
    const con = (await get(`/api/games/${gameId}/console`, fac)).json();
    expect(con.submitted).toEqual({
      FACTORY: true,
      DISTRIBUTOR: true,
      WHOLESALER: true,
      RETAILER: true,
    });
    const commit = await post(`/api/games/${gameId}/commit`, { week: 1 }, fac, {
      'if-match': `"${con.sessionVersion}"`,
      'idempotency-key': 'abc',
    });
    expect(commit.statusCode).toBe(200);
    expect(commit.json()).toMatchObject({ committedWeek: 1, nextWeek: 2 });
    const me = (await get(`/api/games/${gameId}/me`, players.RETAILER)).json();
    expect(me).toMatchObject({ role: 'RETAILER', week: 2 });
    expect(me.history).toHaveLength(1);
  });

  it('[US2.3/AC2.3.2] 確定には Idempotency-Key と If-Match が要る', async () => {
    const { gameId, fac } = await table();
    const res = await post(`/api/games/${gameId}/commit`, { week: 1 }, fac);
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});

describe('自動確定', () => {
  it('[US2.4/AC2.4.1] commitMode=AUTO で作成でき、最後の保存で週が進む', async () => {
    const created = await post('/api/games', { weeks: 2, commitMode: 'AUTO' });
    expect(created.statusCode).toBe(201);
    const fac = cookieOf(created);
    const { gameId, joinCode } = created.json();
    const players: string[] = [];
    for (const role of ROLES) {
      const j = await post('/api/join', { joinCode, displayName: role });
      players.push(cookieOf(j));
      await post(
        `/api/games/${gameId}/assignments`,
        { participantId: j.json().participantId, role },
        fac,
      );
    }
    await post(`/api/games/${gameId}/start`, {}, fac);
    let last;
    for (const [i, role] of ROLES.entries()) {
      last = await server.inject({
        method: 'PUT',
        url: `/api/games/${gameId}/decision`,
        payload: { role, quantity: 4 },
        headers: { origin: ORIGIN, cookie: players[i]!, 'if-match': '"0"' },
      });
    }
    expect(last!.json().committed).toMatchObject({
      committedWeek: 1,
      nextWeek: 2,
    });
    expect(
      (await get(`/api/games/${gameId}/lobby`, fac)).json().commitMode,
    ).toBe('AUTO');
  });

  it('commitMode が不正なら 400', async () => {
    expect(
      (await post('/api/games', { weeks: 2, commitMode: 'X' })).statusCode,
    ).toBe(400);
  });
});

describe('同じブラウザでの進行役と参加者', () => {
  it('[US1.2] 進行役が同じブラウザで参加しても、進行役の資格を失わない', async () => {
    const created = await post('/api/games', { weeks: 2 });
    const facCookie = cookieOf(created);
    const { gameId, joinCode } = created.json();
    const joined = await post(
      '/api/join',
      { joinCode, displayName: '一人二役' },
      facCookie,
    );
    const both = `${facCookie}; ${cookieOf(joined)}`;
    expect(facCookie.split('=')[0]).not.toBe(cookieOf(joined).split('=')[0]);

    // 進行役としての操作（割り当て）と、参加者としての操作（状況の取得）が、同じブラウザで両立する
    const lobby = (await get(`/api/games/${gameId}/lobby`, both)).json();
    expect(lobby.viewer).toEqual({ kind: 'FACILITATOR' });
    const assign = await post(
      `/api/games/${gameId}/assignments`,
      { participantId: joined.json().participantId, role: 'RETAILER' },
      both,
    );
    expect(assign.statusCode).toBe(204);
  });

  it('[US1.2] 古いゲームの進行役の資格が残っていても、新しいゲームに参加者として入れる', async () => {
    const old = await post('/api/games', { weeks: 2 });
    const next = await post('/api/games', { weeks: 2 }, undefined);
    const joined = await post(
      '/api/join',
      { joinCode: next.json().joinCode, displayName: 'x' },
      cookieOf(old),
    );
    const cookies = `${cookieOf(old)}; ${cookieOf(joined)}`;
    const lobby = await get(`/api/games/${next.json().gameId}/lobby`, cookies);
    expect(lobby.statusCode).toBe(200);
    expect(lobby.json().viewer.kind).toBe('PARTICIPANT');
  });
});

describe('振り返り（終了後だけ開示）', () => {
  async function autoGame() {
    const created = await post('/api/games', { weeks: 2, commitMode: 'AUTO' });
    const fac = cookieOf(created);
    const { gameId, joinCode } = created.json();
    const players: string[] = [];
    for (const role of ROLES) {
      const j = await post('/api/join', { joinCode, displayName: role });
      players.push(cookieOf(j));
      await post(
        `/api/games/${gameId}/assignments`,
        { participantId: j.json().participantId, role },
        fac,
      );
    }
    await post(`/api/games/${gameId}/start`, {}, fac);
    const playWeek = async () => {
      for (const [i, role] of ROLES.entries()) {
        await server.inject({
          method: 'PUT',
          url: `/api/games/${gameId}/decision`,
          payload: { role, quantity: 6 },
          headers: { origin: ORIGIN, cookie: players[i]!, 'if-match': '"0"' },
        });
      }
    };
    return { gameId, fac, players, playWeek };
  }

  it('[US4.2/AC4.2.2] 進行中は 403（Problem JSON）で、役割別の値も需要も含まない', async () => {
    const { gameId, fac, players, playWeek } = await autoGame();
    await playWeek(); // 1 週目だけ確定した状態
    for (const cookie of [fac, players[0]!, players[3]!]) {
      const res = await get(`/api/games/${gameId}/review`, cookie);
      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      const body = res.json();
      expect(body).not.toHaveProperty('series');
      expect(body).not.toHaveProperty('demand');
      expect(JSON.stringify(body)).not.toMatch(/"order"|RETAILER|FACTORY/);
    }
  });

  it('[US4.2/AC4.2.1] 終了後は 200 で、週・需要・指標ごとの役割別の系列を返す', async () => {
    const { gameId, fac, players, playWeek } = await autoGame();
    await playWeek();
    await playWeek();
    for (const cookie of [fac, players[1]!]) {
      const res = await get(`/api/games/${gameId}/review`, cookie);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.weeks).toEqual([1, 2]);
      expect(body.demand).toEqual([4, 4]);
      expect(Object.keys(body.series).sort()).toEqual([
        'backlog',
        'cost',
        'inventory',
        'order',
        'shipped',
      ]);
      expect(body.series.order.RETAILER).toEqual([6, 6]);
    }
  });

  it('[US4.2/AC4.2.2] 資格が無ければ 401、他のゲームの資格は 403', async () => {
    const a = await autoGame();
    const b = await autoGame();
    expect((await get(`/api/games/${a.gameId}/review`)).statusCode).toBe(401);
    expect((await get(`/api/games/${a.gameId}/review`, b.fac)).statusCode).toBe(
      403,
    );
  });
});

describe('Origin と認可', () => {
  it('[US6.1] 変更系で Origin が違えば 403', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/games',
      payload: { weeks: 3 },
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('[US2.1/AC2.1.2] 資格が無ければ 401、他のゲームの資格は 403', async () => {
    const a = await table();
    const b = await table();
    expect((await get(`/api/games/${a.gameId}/lobby`)).statusCode).toBe(401);
    expect((await get(`/api/games/${a.gameId}/lobby`, b.fac)).statusCode).toBe(
      403,
    );
  });

  it('[US2.1/AC2.1.2] 他の役割の発注は保存できない（403）', async () => {
    const { gameId, players } = await table();
    const res = await server.inject({
      method: 'PUT',
      url: `/api/games/${gameId}/decision`,
      payload: { role: 'FACTORY', quantity: 1 },
      headers: { origin: ORIGIN, cookie: players.RETAILER!, 'if-match': '"0"' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('[US1.2] 参加者は役割を割り当てられない（403）。解除は進行役だけ', async () => {
    const { gameId, fac, players } = await table();
    const me = (await get(`/api/games/${gameId}/lobby`, fac)).json();
    const pid = me.assignments.RETAILER as string;
    const denied = await server.inject({
      method: 'DELETE',
      url: `/api/games/${gameId}/assignments/${pid}`,
      headers: { origin: ORIGIN, cookie: players.RETAILER! },
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('Problem JSON', () => {
  it('[US1.1/AC1.1.2] 無効な需要系列は 422 で、対象週と修正内容を返す', async () => {
    const res = await post('/api/games', { weeks: 3, demand: [4, 4, 9999] });
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.json()).toMatchObject({
      status: 422,
      issues: [{ week: 3, fix: expect.any(String) }],
      correlationId: expect.any(String),
    });
  });

  it('入力の形式が違えば 400', async () => {
    expect((await post('/api/games', { weeks: 'x' })).statusCode).toBe(400);
  });

  it('[US2.3/AC2.3.2] 古い版の確定は 409', async () => {
    const { gameId, fac } = await table();
    const res = await post(`/api/games/${gameId}/commit`, { week: 1 }, fac, {
      'if-match': '"99"',
      'idempotency-key': 'k',
    });
    expect([409, 422]).toContain(res.statusCode);
  });
});

describe('観測性', () => {
  it('[US6.1/AC6.1.4] /health は常に 200、/ready は DB が使えないと 503', async () => {
    expect((await get('/health')).statusCode).toBe(200);
    expect((await get('/ready')).statusCode).toBe(200);
    dbUp = false;
    expect((await get('/ready')).statusCode).toBe(503);
  });

  it('[US6.1/AC6.1.1] 相関 ID を応答ヘッダーで返し、渡されればそれを使う', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'corr-123' },
    });
    expect(res.headers['x-correlation-id']).toBe('corr-123');
    expect((await get('/health')).headers['x-correlation-id']).toBeTruthy();
  });

  it('[US6.1/AC6.1.1] ログは構造化 JSON で、資格・表示名・Cookie を含まない', async () => {
    const { gameId, fac, players } = await table();
    await get(`/api/games/${gameId}/lobby`, fac);
    await get(`/api/games/${gameId}/me`, players.RETAILER);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) JSON.parse(line);
    const all = logs.join('');
    expect(all).not.toContain('秘密の名前');
    expect(all).not.toContain('token-');
    expect(all).not.toMatch(/bg_session=/);
  });

  it('[US6.1/AC6.1.2] 予期しないエラーは、相関 ID つきで記録され、利用者には詳細を返さない', async () => {
    const { gameId, fac } = await table();
    mem.failEventAppend(true);
    const res = await post(
      `/api/games/${gameId}/assignments`,
      { participantId: 'x', role: 'RETAILER' },
      fac,
      {
        'x-correlation-id': 'corr-err',
      },
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    mem.failEventAppend(false);
    const res2 = await post('/api/games', { weeks: 2 }, undefined, {
      'x-correlation-id': 'corr-500',
    });
    mem.failEventAppend(true);
    const res3 = await post('/api/games', { weeks: 2 }, undefined, {
      'x-correlation-id': 'corr-500',
    });
    expect(res2.statusCode).toBe(201);
    expect(res3.statusCode).toBe(500);
    expect(res3.json().detail).not.toContain('injected');
    const errorLine = logs
      .map((l) => JSON.parse(l))
      .find((l) => l.level >= 50 && l.reqId === 'corr-500');
    expect(errorLine).toBeTruthy();
    expect(JSON.stringify(errorLine)).toContain('injected failure');
  });
});

const put = (url: string, payload: unknown, cookie: string, version: number) =>
  server.inject({
    method: 'PUT',
    url,
    payload: payload as object,
    headers: { origin: ORIGIN, cookie, 'if-match': `"${version}"` },
  });

describe('復帰コード', () => {
  it('[US3.2/AC3.2.1] 作成・参加の応答で復帰コードを一度だけ返し、ログには含めない', async () => {
    const created = await post('/api/games', { weeks: 2 });
    const joined = await post('/api/join', {
      joinCode: created.json().joinCode,
      displayName: '花子',
    });
    const codes = [created.json().recoveryCode, joined.json().recoveryCode];
    for (const code of codes) expect(code).toEqual(expect.any(String));
    for (const code of codes) expect(logs.join('')).not.toContain(code);
  });

  it('[US3.2/AC3.2.1] 参加者が Cookie を失っても、復帰コードで同じ役割の状態を取得できる', async () => {
    const created = await post('/api/games', { weeks: 2 });
    const fac = cookieOf(created);
    const { gameId, joinCode } = created.json();
    let code = '';
    for (const role of ROLES) {
      const j = await post('/api/join', { joinCode, displayName: role });
      if (role === 'RETAILER') code = j.json().recoveryCode;
      await post(
        `/api/games/${gameId}/assignments`,
        { participantId: j.json().participantId, role },
        fac,
      );
    }
    await post(`/api/games/${gameId}/start`, {}, fac);
    const back = await post('/api/recover', { code });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({
      gameId,
      kind: 'PARTICIPANT',
      gameStatus: 'STARTED',
    });
    expect(back.cookies[0]!.name).toBe('bg_participant');
    const me = await get(`/api/games/${gameId}/me`, cookieOf(back));
    expect(me.json()).toMatchObject({ role: 'RETAILER', week: 1 });
  });

  it('[US3.2/AC3.2.4] 進行役は、復帰コードで進行役の Cookie を受け取り、コンソールへ戻れる', async () => {
    const created = await post('/api/games', { weeks: 2 });
    const back = await post('/api/recover', {
      code: created.json().recoveryCode,
    });
    expect(back.json()).toMatchObject({ kind: 'FACILITATOR' });
    expect(back.cookies[0]!.name).toBe('bg_facilitator');
    const lobby = await get(
      `/api/games/${created.json().gameId}/lobby`,
      cookieOf(back),
    );
    expect(lobby.json()).toMatchObject({ viewer: { kind: 'FACILITATOR' } });
  });

  it('[US3.2/AC3.2.2] 無効な復帰コードは 401 で、進行役への確認を示し、失敗を記録する', async () => {
    const res = await post('/api/recover', { code: 'wrong' });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toMatch(/進行役/);
    expect(logs.join('')).toMatch(/復帰に失敗/);
    expect(logs.join('')).not.toContain('wrong');
  });
});

describe('停止・再開・代理入力（HTTP）', () => {
  it('[US3.1/AC3.1.1] 停止中の保存は 422、再開すると保存できる', async () => {
    const { gameId, fac, players } = await table();
    expect((await post(`/api/games/${gameId}/pause`, {}, fac)).statusCode).toBe(
      204,
    );
    const rejected = await put(
      `/api/games/${gameId}/decision`,
      { role: 'RETAILER', quantity: 4 },
      players.RETAILER!,
      0,
    );
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().detail).toMatch(/停止中/);
    expect(
      (await post(`/api/games/${gameId}/resume`, {}, fac)).statusCode,
    ).toBe(204);
    const saved = await put(
      `/api/games/${gameId}/decision`,
      { role: 'RETAILER', quantity: 4 },
      players.RETAILER!,
      0,
    );
    expect(saved.statusCode).toBe(200);
  });

  it('[US3.1/AC3.1.2] 進行役は代理入力でき、古い版は 409。参加者の代理入力は 403', async () => {
    const { gameId, fac, players } = await table();
    const ok = await put(
      `/api/games/${gameId}/proxy-decision`,
      { role: 'FACTORY', quantity: 3 },
      fac,
      0,
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ version: 1 });
    const stale = await put(
      `/api/games/${gameId}/proxy-decision`,
      { role: 'FACTORY', quantity: 5 },
      fac,
      0,
    );
    expect(stale.statusCode).toBe(409);
    const forbidden = await put(
      `/api/games/${gameId}/proxy-decision`,
      { role: 'FACTORY', quantity: 5 },
      players.RETAILER!,
      1,
    );
    expect(forbidden.statusCode).toBe(403);
    const c = await get(`/api/games/${gameId}/console`, fac);
    expect(c.json().versions.FACTORY).toBe(1);
  });
});

describe('資格の再発行（HTTP）', () => {
  it('[US3.2/AC3.2.5] 参加者の資格を再発行すると、古い Cookie は 401 になり、新しい復帰コードが返る', async () => {
    const created = await post('/api/games', { weeks: 2 });
    const fac = cookieOf(created);
    const { gameId, joinCode } = created.json();
    const j = await post('/api/join', { joinCode, displayName: '花子' });
    const res = await post(
      `/api/games/${gameId}/credentials/reissue`,
      { target: 'PARTICIPANT', participantId: j.json().participantId },
      fac,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().recoveryCode).toEqual(expect.any(String));
    expect(res.cookies).toHaveLength(0);
    expect(
      (await get(`/api/games/${gameId}/lobby`, cookieOf(j))).statusCode,
    ).toBe(401);
  });

  it('[US3.2/AC3.2.5] 進行役が自分の資格を再発行すると、新しい Cookie が設定され、古い Cookie は 401', async () => {
    const created = await post('/api/games', { weeks: 2 });
    const fac = cookieOf(created);
    const { gameId } = created.json();
    const res = await post(
      `/api/games/${gameId}/credentials/reissue`,
      { target: 'FACILITATOR' },
      fac,
    );
    expect(res.statusCode).toBe(200);
    expect(res.cookies[0]!.name).toBe('bg_facilitator');
    expect((await get(`/api/games/${gameId}/lobby`, fac)).statusCode).toBe(401);
    expect(
      (await get(`/api/games/${gameId}/lobby`, cookieOf(res))).statusCode,
    ).toBe(200);
  });

  it('対象の形式が違えば 400', async () => {
    const created = await post('/api/games', { weeks: 2 });
    const res = await post(
      `/api/games/${created.json().gameId}/credentials/reissue`,
      { target: 'PARTICIPANT' },
      cookieOf(created),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('参加・復帰のレート制限', () => {
  it('[US3.2] 参加と復帰は、送信元ごとに専用の上限を超えると 429 で、記録を残す', async () => {
    await boot(memoryRateLimiter(2, 60_000));
    for (let i = 0; i < 2; i++)
      expect((await post('/api/recover', { code: 'x' })).statusCode).toBe(401);
    const limited = await post('/api/recover', { code: 'x' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().detail).toMatch(/時間をおいて/);
    expect(logs.join('')).toMatch(/レート制限/);
    // 参加は別のバケット
    const join = await post('/api/join', {
      joinCode: 'NONE',
      displayName: 'a',
    });
    expect(join.statusCode).toBe(404);
  });

  it('ゲームの作成と、ゲーム内の操作は、参加・復帰の制限を受けない', async () => {
    await boot(memoryRateLimiter(1, 60_000));
    const a = await post('/api/games', { weeks: 2 });
    const b = await post('/api/games', { weeks: 2 });
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
  });
});
