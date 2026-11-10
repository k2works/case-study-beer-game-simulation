import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../src/application/index.js';
import { buildServer } from '../../src/adapters/http/server.js';
import { ROLES } from '../../src/domain/role.js';
import {
  fakeCredentials,
  memoryUnitOfWork,
  sequentialIds,
} from '../support/memory.js';

const ORIGIN = 'https://beer.example.test';
let server: FastifyInstance;
let logs: string[];
let dbUp: boolean;
let mem: ReturnType<typeof memoryUnitOfWork>;

beforeEach(async () => {
  logs = [];
  dbUp = true;
  mem = memoryUnitOfWork();
  const app = createApplication({
    uow: mem.uow,
    clock: { now: () => new Date() },
    ids: sequentialIds(),
    credentials: fakeCredentials(),
  });
  server = buildServer({
    app,
    ready: async () => dbUp,
    notifier: { subscribe: () => () => {} },
    config: { allowedOrigin: ORIGIN, logLevel: 'info' },
    logStream: new Writable({
      write(chunk, _enc, cb) {
        logs.push(String(chunk));
        cb();
      },
    }),
  });
  await server.ready();
});

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
