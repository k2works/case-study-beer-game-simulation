import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Application } from '../../src/application/index.js';
import { ROLES } from '../../src/domain/role.js';
import {
  bootApp,
  ORIGIN,
  type Booted,
  type EmittedMetric,
} from '../contract/boot.js';
import {
  endedTable,
  observerOf,
  playWeek,
  preparedTable,
  saveAll,
  startedTable,
  type Table,
} from '../contract/fixtures.js';

// HTTP の層（共有の契約 /api/v1）の、横断の性質: Cookie の属性、Origin と認可、problem+json、ログ、メトリクス、
// セキュリティヘッダー、レート制限、復帰・観察者・出力・保持期間の受入条件。
// 契約のスキーマへの適合は tests/contract が検査する。ここは、受入条件（[US/AC]）ごとの、HTTP を通した振る舞い。

/** 相関 ID は、要求の x-correlation-id が UUID のときだけ使う（共有の契約） */
const CORRELATION_ID = '3f9c1b9e-5b0a-4a53-8b52-0c6b8f2d4a11';

let server: FastifyInstance;
let app: Application;
let mem: Booted['mem'];
let logs: string[];
let emitted: EmittedMetric[];
afterEach(async () => {
  await server?.close();
});
async function boot(options: Parameters<typeof bootApp>[0] = {}) {
  ({ server, app, mem, logs, emitted } = await bootApp({
    logLevel: 'info',
    ...options,
  }));
}

interface Opts {
  token?: string;
  /** `null` なら Idempotency-Key を付けない */
  key?: string | null;
  /** `null` なら Origin を付けない */
  origin?: string | null;
  headers?: Record<string, string>;
}
const send = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
  o: Opts = {},
) =>
  server.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: {
      ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }),
      ...(method === 'GET' || o.key === null
        ? {}
        : { 'idempotency-key': o.key ?? randomUUID() }),
      ...(o.token ? { cookie: `bg_session=${o.token}` } : {}),
      ...o.headers,
    },
  });
const get = (url: string, token?: string) =>
  send('GET', url, undefined, {
    ...(token ? { token } : {}),
    origin: null,
  });
const post = (url: string, payload?: unknown, o: Opts = {}) =>
  send('POST', url, payload, o);
const put = (url: string, payload: unknown, o: Opts = {}) =>
  send('PUT', url, payload, o);

const created = (extra: Record<string, unknown> = {}) => ({
  kind: 'KIT',
  finalWeek: 2,
  demand: [4, 4],
  ...extra,
});
const cookieOf = (
  res: { cookies: { name: string; value: string }[] },
  name = 'bg_session',
) => res.cookies.find((c) => c.name === name)?.value as string;
const ALL_ONE = { FACTORY: 1, DISTRIBUTOR: 1, WHOLESALER: 1, RETAILER: 1 };
const save = (
  t: Table,
  role: (typeof ROLES)[number],
  quantity: number,
  v = 0,
) =>
  put(
    `/api/v1/sessions/${t.gameId}/decisions`,
    { week: 1, quantity },
    { token: t.players[role].token, headers: { 'if-match': `"${v}"` } },
  );
const commit = (t: Table, week: number, basis = ALL_ONE, o: Opts = {}) =>
  post(
    `/api/v1/sessions/${t.gameId}/weeks/${week}/commit`,
    { requestedWeek: week, basis },
    { token: t.facilitator, ...o },
  );

describe('ルートと Cookie', () => {
  it('[US1.1/AC1.1.1] ゲームを作ると 201 で、進行役の Cookie が HttpOnly・Secure・SameSite=Strict で発行される', async () => {
    await boot({ secureCookies: true });
    const res = await post(
      '/api/v1/games',
      created({ finalWeek: 3, demand: [4, 4, 4] }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ recoveryCode: expect.any(String) });
    expect(res.headers.location).toMatch(
      /^\/api\/v1\/games\/[0-9a-f-]+\/state$/,
    );
    const raw = String(res.headers['set-cookie']);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/SameSite=Strict/i);
  });

  it('[US1.2/AC1.2.1] 参加から開始、入力、確定、状態の取得まで通る', async () => {
    await boot();
    const t = await startedTable(app);
    const game = await get(`/api/v1/games/${t.gameId}/state`, t.facilitator);
    expect(game.json()).toMatchObject({ status: 'STARTED' });
    for (const role of ROLES)
      expect((await save(t, role, 4)).statusCode).toBe(200);
    const before = await get(
      `/api/v1/sessions/${t.gameId}/state`,
      t.facilitator,
    );
    expect(before.json().submittedRoleCount).toBe(4);
    expect((await commit(t, 1)).statusCode).toBe(200);
    const own = (
      await get(`/api/v1/sessions/${t.gameId}/state`, t.players.RETAILER.token)
    ).json();
    expect(own).toMatchObject({ role: 'RETAILER', week: 2 });
    const facilitator = (
      await get(`/api/v1/sessions/${t.gameId}/state`, t.facilitator)
    ).json();
    expect(
      facilitator.results.filter(
        (r: { role: string }) => r.role === 'RETAILER',
      ),
    ).toHaveLength(1);
  });

  it('[US2.3/AC2.3.2] 確定には Idempotency-Key と、役割ごとの入力の版（basis）が要る', async () => {
    await boot();
    const t = await startedTable(app);
    const noKey = await commit(t, 1, ALL_ONE, { key: null });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.headers['content-type']).toMatch(/application\/problem\+json/);
    const noBasis = await post(
      `/api/v1/sessions/${t.gameId}/weeks/1/commit`,
      { requestedWeek: 1 },
      { token: t.facilitator },
    );
    expect(noBasis.statusCode).toBe(422);
  });
});

describe('自動確定', () => {
  it('[US2.4/AC2.4.1] commitMode=AUTO で作成でき、最後の保存で週が進む', async () => {
    await boot();
    const res = await post('/api/v1/games', created({ commitMode: 'AUTO' }));
    expect(res.statusCode).toBe(201);
    const t = await startedTable(app, { commitMode: 'AUTO' });
    for (const role of ROLES) await save(t, role, 4);
    const state = await get(
      `/api/v1/sessions/${t.gameId}/state`,
      t.facilitator,
    );
    expect(state.json().week).toBe(2);
    expect(
      (await get(`/api/v1/games/${t.gameId}/state`, t.facilitator)).json()
        .commitMode,
    ).toBe('AUTO');
  });

  it('[US1.1/AC1.1.6] 自動確定は、既定で無効（手動）。有効にして作ると、自動確定のゲームになる', async () => {
    await boot();
    const byDefault = await post('/api/v1/games', created());
    expect(byDefault.statusCode).toBe(201);
    const defaultId = String(byDefault.headers.location).split('/')[4]!;
    expect(
      (
        await get(`/api/v1/games/${defaultId}/state`, cookieOf(byDefault))
      ).json().commitMode,
    ).toBe('MANUAL');
    const auto = await post('/api/v1/games', created({ commitMode: 'AUTO' }));
    const autoId = String(auto.headers.location).split('/')[4]!;
    expect(
      (await get(`/api/v1/games/${autoId}/state`, cookieOf(auto))).json()
        .commitMode,
    ).toBe('AUTO');
  });

  it('commitMode が不正なら 422', async () => {
    await boot();
    expect(
      (await post('/api/v1/games', created({ commitMode: 'X' }))).statusCode,
    ).toBe(422);
  });
});

describe('同じブラウザでの進行役と参加者', () => {
  it('[US1.2] 進行役が同じブラウザの別のタブで参加しても、進行役の資格を失わない（Cookie の名前がタブごとに分かれる）', async () => {
    await boot();
    const tabA = 'aaaaaaaaaaaaaaaa';
    const tabB = 'bbbbbbbbbbbbbbbb';
    const made = await post('/api/v1/games', created(), {
      headers: { 'x-tab-id': tabA },
    });
    const gameId = String(made.headers.location).split('/')[4]!;
    const facilitator = cookieOf(made, `bg_session_${tabA}`);
    const state = await server.inject({
      method: 'GET',
      url: `/api/v1/games/${gameId}/state`,
      headers: {
        cookie: `bg_session_${tabA}=${facilitator}`,
        'x-tab-id': tabA,
      },
    });
    const code = state.json().joinCode as string;
    const joined = await post(
      '/api/v1/participations/join',
      { joinCode: code, displayName: '一人二役' },
      {
        headers: {
          cookie: `bg_session_${tabA}=${facilitator}`,
          'x-tab-id': tabB,
        },
      },
    );
    expect(joined.statusCode).toBe(200);
    const participant = cookieOf(joined, `bg_session_${tabB}`);
    expect(participant).toBeTruthy();
    const jar = `bg_session_${tabA}=${facilitator}; bg_session_${tabB}=${participant}`;
    const asFacilitator = await server.inject({
      method: 'GET',
      url: `/api/v1/games/${gameId}/lobby`,
      headers: { cookie: jar, 'x-tab-id': tabA },
    });
    expect(asFacilitator.statusCode).toBe(200);
    const asParticipant = await server.inject({
      method: 'GET',
      url: `/api/v1/games/${gameId}/lobby`,
      headers: { cookie: jar, 'x-tab-id': tabB },
    });
    expect(asParticipant.statusCode).toBe(403);
  });

  it('[US1.2] 古いゲームの進行役の資格が残っていても、新しいゲームに参加者として入れる', async () => {
    await boot();
    const old = await post('/api/v1/games', created());
    const next = await app.createGame({ weeks: 2, demand: [4, 4] });
    const joined = await post(
      '/api/v1/participations/join',
      { joinCode: next.joinCode, displayName: 'x' },
      { token: cookieOf(old) },
    );
    expect(joined.statusCode).toBe(200);
    const state = await get(
      `/api/v1/games/${next.gameId}/state`,
      cookieOf(joined),
    );
    expect(state.statusCode).toBe(200);
    expect(state.json().participantId).toEqual(expect.any(String));
  });
});

describe('振り返り（終了後だけ開示）', () => {
  it('[US4.2/AC4.2.2] 進行中は 409 game.not_ended（problem+json）で、役割別の値も需要も含まない', async () => {
    await boot();
    const t = await startedTable(app, { commitMode: 'AUTO' });
    await saveAll(app, t, 6); // 自動確定: 4 役割がそろった保存で、1 週目が確定する
    for (const token of [
      t.facilitator,
      t.players.FACTORY.token,
      t.players.RETAILER.token,
    ]) {
      const res = await get(`/api/v1/games/${t.gameId}/review`, token);
      expect(res.statusCode).toBe(409);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      const body = res.json();
      expect(body.code).toBe('game.not_ended');
      expect(body).not.toHaveProperty('results');
      expect(JSON.stringify(body)).not.toMatch(/"order"|RETAILER|FACTORY/);
    }
  });

  it('[US4.2/AC4.2.1] 終了後は 200 で、週・役割ごとの結果（需要・発注・在庫・未出荷・費用）を返す', async () => {
    await boot();
    const t = await startedTable(app);
    await playWeek(app, t, 1, 6);
    await playWeek(app, t, 2, 6);
    for (const token of [t.facilitator, t.players.WHOLESALER.token]) {
      const res = await get(`/api/v1/games/${t.gameId}/review`, token);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.results).toHaveLength(8);
      const retailer = body.results.filter(
        (r: { role: string }) => r.role === 'RETAILER',
      );
      expect(retailer.map((r: { week: number }) => r.week)).toEqual([1, 2]);
      expect(retailer.map((r: { order: number }) => r.order)).toEqual([6, 6]);
      expect(retailer.map((r: { orders: number }) => r.orders)).toEqual([4, 4]);
      expect(Object.keys(retailer[0]).sort()).toEqual(
        [
          'backlog',
          'cost',
          'cumulativeCost',
          'inventory',
          'order',
          'orders',
          'role',
          'shipment',
          'week',
        ].sort(),
      );
    }
  });

  it('[US4.2/AC4.2.2] 資格が無ければ 403、他のゲームの資格も 403', async () => {
    await boot();
    const a = await endedTable(app);
    const b = await startedTable(app);
    expect((await get(`/api/v1/games/${a.gameId}/review`)).statusCode).toBe(
      403,
    );
    expect(
      (await get(`/api/v1/games/${a.gameId}/review`, b.facilitator)).statusCode,
    ).toBe(403);
  });
});

describe('Origin と認可', () => {
  it('[US6.1] 変更系で Origin が違えば 403', async () => {
    await boot();
    const res = await post('/api/v1/games', created(), {
      origin: 'https://evil.example',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('app.unauthorized');
    expect(
      (await post('/api/v1/games', created(), { origin: null })).statusCode,
    ).toBe(403);
  });

  it('[US2.1/AC2.1.2] 資格が無ければ 403、他のゲームの資格も 403（同じ本文）', async () => {
    await boot();
    const a = await startedTable(app);
    const b = await startedTable(app);
    const none = await get(`/api/v1/games/${a.gameId}/lobby`);
    const other = await get(`/api/v1/games/${a.gameId}/lobby`, b.facilitator);
    expect(none.statusCode).toBe(403);
    expect(other.statusCode).toBe(403);
    expect(none.json().code).toBe(other.json().code);
  });

  it('[US2.1/AC2.1.2] 他の役割の状況は取れず、他の役割の入力もできない（403）', async () => {
    await boot();
    const t = await startedTable(app);
    const other = await get(
      `/api/v1/sessions/${t.gameId}/state?role=FACTORY`,
      t.players.RETAILER.token,
    );
    expect(other.statusCode).toBe(403);
    // 進行役は、参加者としては保存できない（役割が資格から決まる）
    const res = await put(
      `/api/v1/sessions/${t.gameId}/decisions`,
      { week: 1, quantity: 1 },
      { token: t.facilitator },
    );
    expect(res.statusCode).toBe(403);
  });

  it('[US1.2] 参加者は役割を割り当てられない（403）', async () => {
    await boot();
    const t = await startedTable(app);
    const res = await put(
      `/api/v1/games/${t.gameId}/participants/${t.players.FACTORY.participantId}/role`,
      { role: 'RETAILER' },
      { token: t.players.RETAILER.token },
    );
    expect(res.statusCode).toBe(403);
  });
});

describe('Problem JSON', () => {
  it('[US1.1/AC1.1.2] 無効な需要系列は 422 で、対象週と修正内容を返す', async () => {
    await boot();
    const res = await post(
      '/api/v1/games',
      created({ finalWeek: 3, demand: [4, 4, 9999] }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.json()).toMatchObject({
      status: 422,
      code: 'validation.invalid_input',
      type: '/problems/validation.invalid_input',
      errors: [{ field: 'demand', week: 3, message: expect.any(String) }],
      correlationId: expect.any(String),
    });
  });

  it('入力の形式が違えば 422、JSON として壊れていれば 400', async () => {
    await boot();
    expect(
      (await post('/api/v1/games', created({ finalWeek: 'x' }))).statusCode,
    ).toBe(422);
    const broken = await server.inject({
      method: 'POST',
      url: '/api/v1/games',
      payload: '{"kind":',
      headers: {
        origin: ORIGIN,
        'idempotency-key': randomUUID(),
        'content-type': 'application/json',
      },
    });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().code).toBe('validation.invalid_input');
  });

  it('[US2.3/AC2.3.2] 確定の根拠（入力の版）が現在と違えば 409 session.decisions_changed', async () => {
    await boot();
    const t = await startedTable(app);
    await saveAll(app, t);
    const res = await commit(t, 1, { ...ALL_ONE, RETAILER: 0 });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('session.decisions_changed');
  });
});

describe('観測性', () => {
  it('[US6.1/AC6.1.4] /health は常に 200、/ready は DB が使えないと 503', async () => {
    let up = true;
    await boot({ ready: async () => up });
    expect((await get('/health')).statusCode).toBe(200);
    expect((await get('/ready')).statusCode).toBe(200);
    up = false;
    expect((await get('/ready')).statusCode).toBe(503);
    const v1 = await get('/api/v1/ready');
    expect(v1.statusCode).toBe(503);
    expect(v1.json().checks).toEqual({ database: false, notifier: true });
  });

  it('[US6.1/AC6.1.1] 相関 ID を応答ヘッダーで返し、渡されればそれを使う', async () => {
    await boot();
    const res = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': CORRELATION_ID },
    });
    expect(res.headers['x-correlation-id']).toBe(CORRELATION_ID);
    expect((await get('/health')).headers['x-correlation-id']).toBeTruthy();
  });

  it('[US6.1/AC6.1.1] ログは構造化 JSON で、資格・表示名・Cookie を含まない', async () => {
    await boot();
    const t = await startedTable(app);
    await get(`/api/v1/games/${t.gameId}/lobby`, t.facilitator);
    await get(`/api/v1/sessions/${t.gameId}/state`, t.players.RETAILER.token);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) JSON.parse(line);
    const all = logs.join('');
    expect(all).not.toContain('参加者-');
    expect(all).not.toContain(t.facilitator);
    expect(all).not.toContain(t.players.RETAILER.token);
    expect(all).not.toMatch(/bg_session=/);
  });

  it('[US6.1/AC6.1.2] 予期しないエラーは、相関 ID つきで記録され、利用者には詳細を返さない', async () => {
    await boot();
    const ok = await post('/api/v1/games', created(), {
      headers: { 'x-correlation-id': randomUUID() },
    });
    expect(ok.statusCode).toBe(201);
    mem.failEventAppend(true);
    const res = await post('/api/v1/games', created(), {
      headers: { 'x-correlation-id': CORRELATION_ID },
    });
    mem.failEventAppend(false);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({
      code: 'app.internal',
      correlationId: CORRELATION_ID,
    });
    expect(JSON.stringify(res.json())).not.toContain('injected');
    const errorLine = logs
      .map((l) => JSON.parse(l))
      .find((l) => l.level >= 50 && l.reqId === CORRELATION_ID);
    expect(errorLine).toBeTruthy();
    expect(JSON.stringify(errorLine)).toContain('injected failure');
  });
});

describe('復帰コード', () => {
  it('[US3.2/AC3.2.1] 作成・参加で復帰コードを一度だけ返し、ログには含めない', async () => {
    await boot();
    const made = await post('/api/v1/games', created());
    const state = await get(
      `/api/v1/games/${String(made.headers.location).split('/')[4]}/state`,
      cookieOf(made),
    );
    const joined = await post('/api/v1/participations/join', {
      joinCode: state.json().joinCode,
      displayName: '花子',
    });
    const codes = [
      made.json().recoveryCode as string,
      cookieOf(joined, 'bg_recovery'),
    ];
    for (const code of codes) expect(code).toEqual(expect.any(String));
    for (const code of codes) expect(logs.join('')).not.toContain(code);
    // 復帰資格の Cookie は、復帰の経路だけに送る
    expect(String(joined.headers['set-cookie'])).toMatch(
      /bg_recovery=.*Path=\/api\/v1\/participations\/recover/,
    );
  });

  it('[US3.2/AC3.2.1] 参加者がブラウザセッションを失っても、復帰コードで同じ役割の状態を取得できる', async () => {
    await boot();
    const t = await preparedTable(app);
    const code = await recoveryCodeOf(t);
    await app.startGame({ token: t.facilitator, gameId: t.gameId });
    const back = await post('/api/v1/participations/recover', {
      gameId: t.gameId,
      recoveryCode: code,
    });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({
      gameId: t.gameId,
      kind: 'PARTICIPANT',
      role: 'RETAILER',
    });
    const state = await get(
      `/api/v1/sessions/${t.gameId}/state`,
      cookieOf(back),
    );
    expect(state.json()).toMatchObject({ role: 'RETAILER', week: 1 });
  });

  it('[US3.2/AC3.2.4] 進行役は、復帰コードで進行役のブラウザセッションを受け取り、ロビーへ戻れる', async () => {
    await boot();
    const made = await post('/api/v1/games', created());
    const gameId = String(made.headers.location).split('/')[4]!;
    const back = await post('/api/v1/participations/recover', {
      gameId,
      recoveryCode: made.json().recoveryCode,
    });
    expect(back.json()).toMatchObject({ kind: 'FACILITATOR' });
    const lobby = await get(`/api/v1/games/${gameId}/lobby`, cookieOf(back));
    expect(lobby.statusCode).toBe(200);
  });

  it('[US3.2/AC3.2.2] 無効な復帰コードは 403 で、失敗を記録する（コードは記録しない）', async () => {
    await boot();
    const made = await post('/api/v1/games', created());
    const gameId = String(made.headers.location).split('/')[4]!;
    const res = await post('/api/v1/participations/recover', {
      gameId,
      recoveryCode: 'wrong',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('app.unauthorized');
    expect(logs.join('')).toMatch(/復帰に失敗/);
    expect(logs.join('')).not.toContain('wrong');
  });
});

/** 小売店の参加者の復帰コード（参加の応答の `bg_recovery`）。前提の準備に使う */
async function recoveryCodeOf(t: Table): Promise<string> {
  const reissued = await app.revokeParticipantCredential({
    token: t.facilitator,
    gameId: t.gameId,
    participantId: t.players.RETAILER.participantId,
  });
  expect(reissued.versions).toBeTruthy();
  const fresh = await app.reissueParticipantCredential({
    token: t.facilitator,
    gameId: t.gameId,
    participantId: t.players.RETAILER.participantId,
  });
  return fresh.recoveryCode;
}

describe('停止・再開・代理入力（HTTP）', () => {
  it('[US3.1/AC3.1.1] 停止中の保存は 409 session.paused、再開すると保存できる', async () => {
    await boot();
    const t = await startedTable(app);
    expect(
      (
        await post(`/api/v1/sessions/${t.gameId}/pause`, undefined, {
          token: t.facilitator,
        })
      ).statusCode,
    ).toBe(200);
    const rejected = await save(t, 'RETAILER', 4);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe('session.paused');
    expect(
      (
        await post(`/api/v1/sessions/${t.gameId}/resume`, undefined, {
          token: t.facilitator,
        })
      ).statusCode,
    ).toBe(200);
    expect((await save(t, 'RETAILER', 4)).statusCode).toBe(200);
  });

  it('[US3.1/AC3.1.2] 進行役は代理入力できる（停止中も）。参加者の代理入力は 403', async () => {
    await boot();
    const t = await startedTable(app);
    await post(`/api/v1/sessions/${t.gameId}/pause`, undefined, {
      token: t.facilitator,
    });
    const ok = await put(
      `/api/v1/sessions/${t.gameId}/proxy-decisions/FACTORY`,
      { requestedWeek: 1, quantity: 3 },
      { token: t.facilitator },
    );
    expect(ok.statusCode).toBe(200);
    const forbidden = await put(
      `/api/v1/sessions/${t.gameId}/proxy-decisions/FACTORY`,
      { requestedWeek: 1, quantity: 5 },
      { token: t.players.RETAILER.token },
    );
    expect(forbidden.statusCode).toBe(403);
    const state = await get(
      `/api/v1/sessions/${t.gameId}/state`,
      t.facilitator,
    );
    expect(state.json().roles.FACTORY.decisionVersion).toBe(1);
  });
});

describe('資格の失効と再発行（HTTP）', () => {
  it('[US3.2/AC3.2.5] 参加者の資格を失効させると古い資格は 403 になり、再発行すると新しい復帰コードが返る', async () => {
    await boot();
    const t = await startedTable(app);
    const target = t.players.RETAILER;
    const subject = {
      subject: { kind: 'PARTICIPANT', id: target.participantId },
    };
    const revoked = await post(
      `/api/v1/games/${t.gameId}/credentials/revoke`,
      subject,
      { token: t.facilitator },
    );
    expect(revoked.statusCode).toBe(200);
    expect(
      (await get(`/api/v1/sessions/${t.gameId}/state`, target.token))
        .statusCode,
    ).toBe(403);
    const reissued = await post(
      `/api/v1/games/${t.gameId}/credentials/reissue`,
      subject,
      { token: t.facilitator },
    );
    expect(reissued.statusCode).toBe(200);
    expect(reissued.json().recoveryCode).toEqual(expect.any(String));
    expect(reissued.cookies).toHaveLength(0);
  });

  it('対象の形式が違えば 422', async () => {
    await boot();
    const t = await startedTable(app);
    const res = await post(
      `/api/v1/games/${t.gameId}/credentials/reissue`,
      { subject: { kind: 'PARTICIPANT' } },
      { token: t.facilitator },
    );
    expect(res.statusCode).toBe(422);
  });
});

describe('参加・復帰のレート制限', () => {
  it('[US3.2] 参加と復帰は、送信元ごとに専用の上限を超えると 429（Retry-After つき）で、記録を残す', async () => {
    await boot({ rateLimit: 2 });
    const body = { gameId: randomUUID(), recoveryCode: 'x' };
    for (let i = 0; i < 2; i++)
      expect(
        (await post('/api/v1/participations/recover', body)).statusCode,
      ).toBe(403);
    const limited = await post('/api/v1/participations/recover', body);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('app.rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(logs.join('')).toMatch(/レート制限/);
    // 参加は別のバケット
    const join = await post('/api/v1/participations/join', {
      joinCode: 'NONE',
      displayName: 'a',
    });
    expect(join.statusCode).toBe(403);
    expect(join.json().code).toBe('game.invitation_invalid');
  });

  it('ゲームの作成と、ゲーム内の操作は、参加・復帰の制限を受けない', async () => {
    await boot({ rateLimit: 1 });
    const a = await post('/api/v1/games', created());
    const b = await post('/api/v1/games', created());
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
  });
});

describe('共同入力の競合（HTTP）', () => {
  it('[US2.2/AC2.2.3] 古い版の保存は 409 で、最新の値・版・保存者の表示名を同じ応答で返す', async () => {
    await boot();
    const t = await startedTable(app);
    await save(t, 'RETAILER', 6);
    const res = await save(t, 'RETAILER', 9);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      status: 409,
      code: 'session.decision_conflict',
      role: 'RETAILER',
      latest: {
        quantity: 6,
        version: 1,
        editor: { kind: 'PARTICIPANT', displayName: '参加者-RETAILER' },
      },
    });
    // 表示名は応答にだけ含め、ログには残さない
    expect(logs.join('')).not.toContain('参加者-');
  });

  it('[US3.2/AC3.2.3] 他のタブで週が確定された後の保存は、古い週として拒否され、新しい状態を黙って上書きしない', async () => {
    await boot();
    const t = await startedTable(app);
    await saveAll(app, t);
    expect((await commit(t, 1)).statusCode).toBe(200);
    // 確定前の画面（第 1 週）からの保存
    const stale = await save(t, 'RETAILER', 99);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'session.week_advanced',
      requestedWeek: 1,
      currentWeek: 2,
    });
    const own = (
      await get(`/api/v1/sessions/${t.gameId}/state`, t.players.RETAILER.token)
    ).json();
    expect(own).toMatchObject({ week: 2 });
    expect(own.roleStatus.decision).toBeNull();
    // 確定前の画面からの、確定の再送（別のキー）も、二重には確定しない
    const again = await commit(t, 1);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('session.week_advanced');
  });

  it('[US2.2/AC2.2.3] 役割の無い資格には、競合ではなく権限エラーを返し、値を含めない', async () => {
    await boot();
    const t = await startedTable(app);
    await save(t, 'RETAILER', 6);
    const res = await put(
      `/api/v1/sessions/${t.gameId}/decisions`,
      { week: 1, quantity: 1 },
      { token: t.facilitator, headers: { 'if-match': '"0"' } },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().latest).toBeUndefined();
  });
});

describe('カスタム条件（HTTP）', () => {
  it('[US1.1/AC1.1.4] 条件を渡して作成でき、ロビーに種別と変更項目が出る', async () => {
    await boot();
    const res = await post(
      '/api/v1/games',
      created({
        kind: 'CUSTOM',
        finalWeek: 3,
        demand: [4, 4, 4],
        conditions: {
          initialInventory: { RETAILER: 20 },
          disclosurePolicy: 'NONE',
        },
      }),
    );
    expect(res.statusCode).toBe(201);
    const gameId = String(res.headers.location).split('/')[4]!;
    const lobby = await get(`/api/v1/games/${gameId}/lobby`, cookieOf(res));
    expect(lobby.json()).toMatchObject({
      settingsKind: 'CUSTOM',
      changedSettings: ['INITIAL_INVENTORY', 'DISCLOSURE'],
    });
  });

  it('[US1.1/AC1.1.4] 範囲外の条件は 422 で、項目ごとに修正内容を返す', async () => {
    await boot();
    const res = await post(
      '/api/v1/games',
      created({
        kind: 'CUSTOM',
        finalWeek: 3,
        demand: [4, 4, 4],
        conditions: { shipmentDelayWeeks: 9, backlogCostMinor: 100_001 },
      }),
    );
    expect(res.statusCode).toBe(422);
    expect(
      res
        .json()
        .errors.map((e: { field: string }) => e.field)
        .sort(),
    ).toEqual(['conditions.backlogCostMinor', 'conditions.shipmentDelayWeeks']);
  });

  it('未知の条件の項目は 422', async () => {
    await boot();
    const res = await post(
      '/api/v1/games',
      created({ kind: 'CUSTOM', conditions: { unknown: 1 } }),
    );
    expect(res.statusCode).toBe(422);
  });
});

describe('確定方式の変更（HTTP）', () => {
  it('[US2.4/AC2.4.5] 進行役は PUT で確定方式を変えられる。参加者は 403、不正な値は 422', async () => {
    await boot();
    const t = await startedTable(app);
    const change = (token: string, commitMode: unknown) =>
      put(
        `/api/v1/sessions/${t.gameId}/commit-mode`,
        { commitMode },
        { token },
      );
    expect((await change(t.facilitator, 'AUTO')).statusCode).toBe(200);
    expect(
      (await get(`/api/v1/games/${t.gameId}/state`, t.facilitator)).json()
        .commitMode,
    ).toBe('AUTO');
    expect((await change(t.players.RETAILER.token, 'MANUAL')).statusCode).toBe(
      403,
    );
    expect((await change(t.facilitator, 'SOMETIMES')).statusCode).toBe(422);
  });
});

describe('観察者（HTTP）', () => {
  const invite = (t: Table, token = t.facilitator) =>
    post(`/api/v1/games/${t.gameId}/observer-invitations`, undefined, {
      token,
    });

  it('[US1.3/AC1.3.1] 進行役が招待を発行すると招待コードが返り、観察者は参加するとブラウザセッションを受け取る', async () => {
    await boot();
    const t = await startedTable(app);
    const inv = await invite(t);
    expect(inv.statusCode).toBe(200);
    expect(inv.json()).toMatchObject({
      invitationId: expect.any(String),
      invitationCode: expect.any(String),
    });
    expect(logs.join('')).not.toContain(inv.json().invitationCode);
    const joined = await post('/api/v1/participations/observe', {
      invitationCode: inv.json().invitationCode,
      displayName: '見学者',
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({ gameId: t.gameId, kind: 'OBSERVER' });
    expect(cookieOf(joined)).toBeTruthy();
    expect(String(joined.headers['set-cookie'])).toMatch(/HttpOnly/i);
  });

  it('[US1.3/AC1.3.2] 参加者が招待を求めると 403', async () => {
    await boot();
    const t = await startedTable(app);
    expect((await invite(t, t.players.RETAILER.token)).statusCode).toBe(403);
  });

  it('[US4.1/AC4.1.1] 観察者は観察を取得でき、役割別の値と需要を含まない', async () => {
    await boot();
    const t = await startedTable(app);
    const observer = await observerOf(app, t);
    await saveAll(app, t, 7);
    const res = await get(`/api/v1/games/${t.gameId}/observation`, observer);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ week: 1, submittedRoleCount: 4 });
    expect(JSON.stringify(res.json())).not.toMatch(/demand|:7[,}]/);
  });

  it('[US4.1/AC4.1.2][US4.1/AC4.1.5] 観察者の資格では、役割別の状況・ロビーは 403、変更の操作も 403', async () => {
    await boot();
    const t = await startedTable(app);
    const observer = await observerOf(app, t);
    for (const url of [
      `/api/v1/sessions/${t.gameId}/state`,
      `/api/v1/games/${t.gameId}/lobby`,
    ])
      expect((await get(url, observer)).statusCode).toBe(403);
    const writes = [
      put(
        `/api/v1/sessions/${t.gameId}/decisions`,
        { week: 1, quantity: 1 },
        { token: observer, headers: { 'if-match': '"0"' } },
      ),
      put(
        `/api/v1/sessions/${t.gameId}/proxy-decisions/RETAILER`,
        { requestedWeek: 1, quantity: 1 },
        { token: observer },
      ),
      commit(t, 1, ALL_ONE, { token: observer }),
      post(`/api/v1/sessions/${t.gameId}/pause`, undefined, {
        token: observer,
      }),
      invite(t, observer),
    ];
    for (const res of await Promise.all(writes))
      expect(res.statusCode).toBe(403);
  });

  it('[US4.1/AC4.1.4] 参加者は観察を開けない（403）。資格が無くても 403', async () => {
    await boot();
    const t = await startedTable(app);
    expect(
      (
        await get(
          `/api/v1/games/${t.gameId}/observation`,
          t.players.RETAILER.token,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await get(`/api/v1/games/${t.gameId}/observation`)).statusCode,
    ).toBe(403);
  });

  it('[US1.3/AC1.3.4] 進行役が招待を失効させると、その招待での参加は 403（招待が無効）で、失敗を記録する', async () => {
    await boot();
    const t = await startedTable(app);
    const inv = await invite(t);
    const revoked = await post(
      `/api/v1/games/${t.gameId}/observer-invitations/${inv.json().invitationId}/revoke`,
      undefined,
      { token: t.facilitator },
    );
    expect(revoked.statusCode).toBe(200);
    const res = await post('/api/v1/participations/observe', {
      invitationCode: inv.json().invitationCode,
      displayName: '見学者',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('game.invitation_invalid');
    expect(logs.join('')).toMatch(/観察者の参加に失敗/);
  });

  it('[US3.2] 観察者の参加も、送信元ごとの専用の上限を超えると 429', async () => {
    await boot({ rateLimit: 1 });
    const body = { invitationCode: 'x', displayName: '見学者' };
    expect(
      (await post('/api/v1/participations/observe', body)).statusCode,
    ).toBe(403);
    expect(
      (await post('/api/v1/participations/observe', body)).statusCode,
    ).toBe(429);
  });
});

describe('出力（HTTP）', () => {
  const exportUrl = (gameId: string, format: string) =>
    `/api/v1/games/${gameId}/exports?format=${format}`;

  it('[US4.3/AC4.3.1] 進行役は終了後に CSV を添付ファイルとして受け取り、SHA-256 のチェックサムが付く', async () => {
    await boot();
    const t = await endedTable(app, { weeks: 1 });
    const res = await get(exportUrl(t.gameId, 'csv'), t.facilitator);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="beer-game-${t.gameId}.csv"`,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-export-checksum']).toBe(
      `sha256-${createHash('sha256').update(res.body, 'utf8').digest('hex')}`,
    );
    expect(res.headers['x-export-schema-version']).toBe(
      'beer-game-kotlin.export.v1',
    );
    expect(res.body.split(/\r?\n/)[0]).toMatch(/^schema_version,game_id/);
  });

  it('[US4.3/AC4.3.2] JSON にもスキーマ版が入る', async () => {
    await boot();
    const t = await endedTable(app, { weeks: 1 });
    const res = await get(exportUrl(t.gameId, 'json'), t.facilitator);
    expect(res.statusCode).toBe(200);
    expect(res.json().schemaVersion).toBe('beer-game-kotlin.export.v1');
  });

  it('[US4.3] 参加者は 403、形式が違えば 422、進行中は 409 game.not_ended', async () => {
    await boot();
    const t = await endedTable(app, { weeks: 1 });
    expect(
      (await get(exportUrl(t.gameId, 'csv'), t.players.RETAILER.token))
        .statusCode,
    ).toBe(403);
    expect(
      (await get(exportUrl(t.gameId, 'xml'), t.facilitator)).statusCode,
    ).toBe(422);
    const running = await startedTable(app);
    const res = await get(
      exportUrl(running.gameId, 'csv'),
      running.facilitator,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('game.not_ended');
  });
});

describe('保持期間（HTTP）', () => {
  it('[US5.1/AC5.1.1] 保持期間を渡して作成でき、進行役に削除予定日とバックアップの期間が出る。範囲外は 422', async () => {
    await boot();
    const res = await post(
      '/api/v1/games',
      created({ finalWeek: 3, demand: [4, 4, 4], retentionDays: 30 }),
    );
    expect(res.statusCode).toBe(201);
    const gameId = String(res.headers.location).split('/')[4]!;
    const retention = await get(
      `/api/v1/games/${gameId}/retention`,
      cookieOf(res),
    );
    expect(retention.json()).toMatchObject({
      retentionDays: 30,
      backupRetentionDays: 7,
    });
    expect(
      (
        await post(
          '/api/v1/games',
          created({ finalWeek: 3, demand: [4, 4, 4], retentionDays: 4000 }),
        )
      ).statusCode,
    ).toBe(422);
  });
});

describe('メトリクス（EMF）', () => {
  const named = (name: string) =>
    emitted.filter((e) => e.metrics.some((m) => m.name === name));

  it('[US6.1/AC6.1.3] 要求のたびに、応答時間と件数を、ID を含まないルートと状態の区分で出す', async () => {
    await boot();
    const t = await startedTable(app);
    emitted.length = 0;
    await get(`/api/v1/games/${t.gameId}/state`, t.facilitator);
    const [e] = named('Latency');
    expect(e!.dimensions).toEqual({
      Route: '/api/v1/games/:gameId/state',
      Method: 'GET',
      StatusClass: '2xx',
    });
    expect(e!.metrics).toEqual(
      expect.arrayContaining([
        { name: 'Latency', value: expect.any(Number), unit: 'Milliseconds' },
        { name: 'Requests', value: 1, unit: 'Count' },
      ]),
    );
    expect(JSON.stringify(emitted)).not.toContain(t.gameId);
  });

  it('[US6.1/AC6.1.3] 入力の競合（409）を数える', async () => {
    await boot();
    const t = await startedTable(app);
    await save(t, 'RETAILER', 1);
    emitted.length = 0;
    await save(t, 'RETAILER', 2);
    expect(named('Conflicts')[0]!.dimensions.Route).toBe(
      '/api/v1/sessions/:sessionId/decisions',
    );
  });

  it('[US6.1/AC6.1.3] 週の確定を、確定の方式（手動・自動）ごとに数える', async () => {
    await boot();
    const manual = await startedTable(app);
    await saveAll(app, manual);
    emitted.length = 0;
    expect((await commit(manual, 1)).statusCode).toBe(200);
    expect(named('WeekCommitted').map((e) => e.dimensions.CommitKind)).toEqual([
      'MANUAL',
    ]);
    const auto = await startedTable(app, { commitMode: 'AUTO' });
    for (const role of ROLES) await save(auto, role, 4);
    expect(named('WeekCommitted').map((e) => e.dimensions.CommitKind)).toEqual([
      'MANUAL',
      'AUTO',
    ]);
  });

  it('[US6.1/AC6.1.6] 予期しないエラー（500）を、不変条件の違反の候補として数える', async () => {
    await boot();
    const t = await startedTable(app);
    mem.failEventAppend(true);
    emitted.length = 0;
    const res = await post(`/api/v1/sessions/${t.gameId}/pause`, undefined, {
      token: t.facilitator,
    });
    mem.failEventAppend(false);
    expect(res.statusCode).toBe(500);
    expect(named('ServerErrors')).toHaveLength(1);
    expect(named('InvariantViolations')).toHaveLength(1);
  });
});

describe('合成監視の入口', () => {
  it('[US6.1/AC6.1.5] CloudFront 経由で呼べる /api/v1/ready が、DB が使えないと 503（problem+json）', async () => {
    let up = true;
    await boot({ ready: async () => up });
    expect((await get('/api/v1/ready')).statusCode).toBe(200);
    up = false;
    const res = await get('/api/v1/ready');
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});

describe('セキュリティヘッダー', () => {
  it.each(['/health', '/api/v1/ready', '/api/v1/games/x/state'])(
    '[US6.2] %s の応答に、HSTS・nosniff・Referrer-Policy・CSP・X-Frame-Options が付く',
    async (url) => {
      await boot();
      const res = await get(url);
      expect(res.headers['strict-transport-security']).toBe(
        'max-age=31536000; includeSubDomains',
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(res.headers['x-frame-options']).toBe('DENY');
    },
  );
});
