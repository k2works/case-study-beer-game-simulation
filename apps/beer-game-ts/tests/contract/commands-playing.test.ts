import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Application } from '../../src/application/index.js';
import { ROLES, type Role } from '../../src/domain/role.js';
import { bootApp, ORIGIN } from './boot.js';
import { observerOf, startedTable, type Table } from './fixtures.js';
import { expectConforms } from './spec.js';

// 進行中のコマンド（saveDecision・commitWeek・pauseSession・resumeSession・setCommitMode・submitProxyDecision）が、
// 共有の契約に適合し、契約の規則（週の判定が先・共同入力の競合・確定の根拠・停止中の扱い）を守る

let server: FastifyInstance;
let app: Application;
afterEach(async () => {
  await server?.close();
});
async function boot() {
  ({ server, app } = await bootApp());
}

interface Sent {
  key?: string | null;
  ifMatch?: string;
}
const send = (
  method: 'PUT' | 'POST',
  url: string,
  token: string,
  payload?: unknown,
  sent: Sent = {},
) =>
  server.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: {
      origin: ORIGIN,
      cookie: `bg_session=${token}`,
      ...(sent.key === null
        ? {}
        : { 'idempotency-key': sent.key ?? randomUUID() }),
      ...(sent.ifMatch === undefined ? {} : { 'if-match': sent.ifMatch }),
    },
  });

const save = (
  table: Table,
  role: Role,
  quantity: number,
  options: Sent & { week?: number; token?: string } = {},
) =>
  send(
    'PUT',
    `/api/v1/sessions/${table.gameId}/decisions`,
    options.token ?? table.players[role].token,
    { week: options.week ?? 1, quantity },
    options,
  );
const commit = (
  table: Table,
  body: unknown,
  options: Sent & { week?: number; token?: string } = {},
) =>
  send(
    'POST',
    `/api/v1/sessions/${table.gameId}/weeks/${options.week ?? 1}/commit`,
    options.token ?? table.facilitator,
    body,
    options,
  );
const facilitatorPost = (table: Table, action: 'pause' | 'resume') =>
  send('POST', `/api/v1/sessions/${table.gameId}/${action}`, table.facilitator);
const setMode = (table: Table, commitMode: string) =>
  send(
    'PUT',
    `/api/v1/sessions/${table.gameId}/commit-mode`,
    table.facilitator,
    { commitMode },
  );
const proxy = (table: Table, role: string, body: unknown, token?: string) =>
  send(
    'PUT',
    `/api/v1/sessions/${table.gameId}/proxy-decisions/${role}`,
    token ?? table.facilitator,
    body,
  );

const basisOf = (versions: Partial<Record<Role, number>> = {}) =>
  Object.fromEntries(ROLES.map((r) => [r, versions[r] ?? 0]));

/** 4 役割が、HTTP で、当週の発注を保存する（版は 1 になる） */
async function saveAllOverHttp(table: Table, quantity = 4) {
  for (const role of ROLES) {
    const res = await save(table, role, quantity);
    expect(res.statusCode).toBe(200);
  }
}

describe('saveDecision（PUT /sessions/{sessionId}/decisions）', () => {
  it('役割は資格から決まり、保存すると session の版だけが進む（game は null）', async () => {
    await boot();
    const table = await startedTable(app);
    const res = await save(table, 'RETAILER', 6);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectConforms('CommandResponse', body);
    expect(body.versions.game).toBeNull();
    expect(body.versions.session).toBeGreaterThan(0);
    const state = await server.inject({
      method: 'GET',
      url: `/api/v1/sessions/${table.gameId}/state?role=RETAILER`,
      headers: { cookie: `bg_session=${table.players.RETAILER.token}` },
    });
    expectConforms('SessionState', state.json());
    expect(state.json().roleStatus.decision).toBe(6);
    expect(state.json().roleStatus.decisionVersion).toBe(1);
  });

  it('進行役・観察者・役割の無い資格は 403（資格の失敗と同じ）', async () => {
    await boot();
    const table = await startedTable(app);
    const observer = await observerOf(app, table);
    for (const token of [table.facilitator, observer, 'unknown']) {
      const res = await save(table, 'RETAILER', 5, { token });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('app.unauthorized');
    }
  });

  it('Idempotency-Key が無ければ 400。同じキーの再送は同じ応答（版を進めない）', async () => {
    await boot();
    const table = await startedTable(app);
    const missing = await save(table, 'RETAILER', 5, { key: null });
    expect(missing.statusCode).toBe(400);
    const key = randomUUID();
    const first = await save(table, 'RETAILER', 5, { key });
    const again = await save(table, 'RETAILER', 5, { key });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    const other = await save(table, 'RETAILER', 7, { key });
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe('app.idempotency_key_reused');
  });

  it('If-Match の版が古ければ 409 session.decision_conflict（role と最新の入力。拒否した保存は版を進めない）', async () => {
    await boot();
    const table = await startedTable(app);
    const first = await save(table, 'RETAILER', 6, { ifMatch: '0' });
    expect(first.statusCode).toBe(200);
    const stale = await save(table, 'RETAILER', 9, { ifMatch: '"0"' });
    expect(stale.statusCode).toBe(409);
    const body = stale.json();
    expectConforms('ConflictProblemBody', body);
    expect(body).toMatchObject({
      code: 'session.decision_conflict',
      role: 'RETAILER',
      latest: { quantity: 6, version: 1 },
    });
    expect(body.latest.editor.kind).toBe('PARTICIPANT');
    expect(body.latest.editor.isSelf).toBe(true);
    // 最新の版を指定して保存し直せば、受け付ける
    const retry = await save(table, 'RETAILER', 9, { ifMatch: '1' });
    expect(retry.statusCode).toBe(200);
  });

  it('If-Match が整数でなければ 422（field は If-Match）。範囲外・形の誤りの数量は 422（field は quantity）', async () => {
    await boot();
    const table = await startedTable(app);
    const bad = await save(table, 'RETAILER', 5, { ifMatch: 'abc' });
    expect(bad.statusCode).toBe(422);
    expectConforms('ValidationProblemBody', bad.json());
    expect(bad.json().errors[0].field).toBe('If-Match');
    for (const quantity of [-1, 1001, 1.5]) {
      const res = await save(table, 'RETAILER', quantity);
      expect(res.statusCode).toBe(422);
      expect(res.json().errors[0].field).toBe('quantity');
    }
    const text = await send(
      'PUT',
      `/api/v1/sessions/${table.gameId}/decisions`,
      table.players.RETAILER.token,
      { week: 1, quantity: 'many' },
    );
    expect(text.statusCode).toBe(422);
    expect(text.json().errors[0].field).toBe('quantity');
  });

  it('週が違えば 409 session.week_advanced（requestedWeek・currentWeek。版が違っても週が先）', async () => {
    await boot();
    const table = await startedTable(app);
    const res = await save(table, 'RETAILER', 5, { week: 2, ifMatch: '7' });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expectConforms('ConflictProblemBody', body);
    expect(body).toMatchObject({
      code: 'session.week_advanced',
      requestedWeek: 2,
      currentWeek: 1,
    });
  });

  it('1 役割・1 週あたり 9 回まで。10 回目は 409 session.save_limit_reached', async () => {
    await boot();
    const table = await startedTable(app);
    for (let i = 0; i < 9; i++) {
      const res = await save(table, 'RETAILER', i, { ifMatch: String(i) });
      expect(res.statusCode).toBe(200);
    }
    const res = await save(table, 'RETAILER', 3, { ifMatch: '9' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('session.save_limit_reached');
  });

  it('停止中は 409 session.paused、終了後は 409 session.already_ended、開始前は 409 session.not_active', async () => {
    await boot();
    const table = await startedTable(app);
    await facilitatorPost(table, 'pause');
    const paused = await save(table, 'RETAILER', 5);
    expect(paused.statusCode).toBe(409);
    expect(paused.json().code).toBe('session.paused');

    await boot();
    const ended = await startedTable(app, { weeks: 1 });
    await saveAllOverHttp(ended);
    const done = await commit(ended, {
      requestedWeek: 1,
      basis: basisOf(Object.fromEntries(ROLES.map((r) => [r, 1]))),
    });
    expect(done.statusCode).toBe(200);
    const after = await save(ended, 'RETAILER', 5);
    expect(after.statusCode).toBe(409);
    expect(after.json().code).toBe('session.already_ended');

    await boot();
    const prepared = await app.createGame({ weeks: 2, demand: [4, 4] });
    const joined = await app.joinGame({
      joinCode: prepared.joinCode,
      displayName: '参加者',
    });
    const early = await send(
      'PUT',
      `/api/v1/sessions/${prepared.gameId}/decisions`,
      joined.token,
      { week: 1, quantity: 4 },
    );
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('session.not_active');
  });
});

describe('commitWeek（POST /sessions/{sessionId}/weeks/{week}/commit）', () => {
  it('4 役割の入力がそろい、根拠（basis）が現在と同じなら確定する（結果は state で見る）', async () => {
    await boot();
    const table = await startedTable(app);
    await saveAllOverHttp(table);
    const res = await commit(table, {
      requestedWeek: 1,
      basis: basisOf(Object.fromEntries(ROLES.map((r) => [r, 1]))),
    });
    expect(res.statusCode).toBe(200);
    expectConforms('CommandResponse', res.json());
    const state = await server.inject({
      method: 'GET',
      url: `/api/v1/sessions/${table.gameId}/state`,
      headers: { cookie: `bg_session=${table.facilitator}` },
    });
    expect(state.json().week).toBe(2);
  });

  it('同じ Idempotency-Key の再送は、保存した応答を返し、二重に確定しない', async () => {
    await boot();
    const table = await startedTable(app);
    await saveAllOverHttp(table);
    const body = {
      requestedWeek: 1,
      basis: basisOf(Object.fromEntries(ROLES.map((r) => [r, 1]))),
    };
    const key = randomUUID();
    const first = await commit(table, body, { key });
    const again = await commit(table, body, { key });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
  });

  it('入力が揃っていなければ 422 session.incomplete_decisions（不足する役割）', async () => {
    await boot();
    const table = await startedTable(app);
    await save(table, 'RETAILER', 4);
    const res = await commit(table, {
      requestedWeek: 1,
      basis: basisOf({ RETAILER: 1 }),
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expectConforms('IncompleteDecisionsProblemBody', body);
    expect(body.code).toBe('session.incomplete_decisions');
    expect(body.missingRoles).toEqual(['FACTORY', 'DISTRIBUTOR', 'WHOLESALER']);
  });

  it('根拠が現在と違えば 409 session.decisions_changed（week・current。保存者・時刻つき）', async () => {
    await boot();
    const table = await startedTable(app);
    await saveAllOverHttp(table);
    const res = await commit(table, {
      requestedWeek: 1,
      basis: basisOf(), // 確認の時点は、まだ誰も保存していなかった
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expectConforms('ConflictProblemBody', body);
    expect(body).toMatchObject({ code: 'session.decisions_changed', week: 1 });
    expect(Object.keys(body.current).sort()).toEqual([...ROLES].sort());
    expect(body.current.RETAILER).toMatchObject({ quantity: 4, version: 1 });
    expect(body.current.RETAILER.editor.kind).toBe('PARTICIPANT');
  });

  it('週が違えば 409 session.week_advanced（版も違っていても、週が先）', async () => {
    await boot();
    const table = await startedTable(app);
    const res = await commit(
      table,
      { requestedWeek: 2, basis: basisOf() },
      { week: 2 },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'session.week_advanced',
      requestedWeek: 2,
      currentWeek: 1,
    });
  });

  it('経路の週と本文の requestedWeek が違えば 422（field は requestedWeek）', async () => {
    await boot();
    const table = await startedTable(app);
    const res = await commit(
      table,
      { requestedWeek: 2, basis: basisOf() },
      { week: 1 },
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0].field).toBe('requestedWeek');
  });

  it('進行役でなければ 403。停止中は 409 session.paused', async () => {
    await boot();
    const table = await startedTable(app);
    await saveAllOverHttp(table);
    const body = {
      requestedWeek: 1,
      basis: basisOf(Object.fromEntries(ROLES.map((r) => [r, 1]))),
    };
    const player = await commit(table, body, {
      token: table.players.RETAILER.token,
    });
    expect(player.statusCode).toBe(403);
    expect(player.json().code).toBe('app.unauthorized');
    await facilitatorPost(table, 'pause');
    const paused = await commit(table, body);
    expect(paused.statusCode).toBe(409);
    expect(paused.json().code).toBe('session.paused');
  });
});

describe('pauseSession・resumeSession（POST /sessions/{sessionId}/pause|resume）', () => {
  it('停止して再開できる（停止中の再停止は session.paused、停止中でない再開は session.not_paused）', async () => {
    await boot();
    const table = await startedTable(app);
    const notPaused = await facilitatorPost(table, 'resume');
    expect(notPaused.statusCode).toBe(409);
    expect(notPaused.json().code).toBe('session.not_paused');

    const paused = await facilitatorPost(table, 'pause');
    expect(paused.statusCode).toBe(200);
    expectConforms('CommandResponse', paused.json());
    const again = await facilitatorPost(table, 'pause');
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('session.paused');

    const resumed = await facilitatorPost(table, 'resume');
    expect(resumed.statusCode).toBe(200);
    expectConforms('CommandResponse', resumed.json());
    expect(resumed.json().versions.session).toBeGreaterThan(
      paused.json().versions.session,
    );
  });

  it('進行役でなければ 403（参加者・観察者）。開始前は 409 session.not_active', async () => {
    await boot();
    const table = await startedTable(app);
    for (const action of ['pause', 'resume'] as const) {
      const res = await send(
        'POST',
        `/api/v1/sessions/${table.gameId}/${action}`,
        table.players.RETAILER.token,
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('app.unauthorized');
    }
    await boot();
    const created = await app.createGame({ weeks: 2, demand: [4, 4] });
    const early = await send(
      'POST',
      `/api/v1/sessions/${created.gameId}/pause`,
      created.facilitatorToken,
    );
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('session.not_active');
  });

  it('終了後は 409 session.already_ended', async () => {
    await boot();
    const table = await startedTable(app, { weeks: 1 });
    await saveAllOverHttp(table);
    await commit(table, {
      requestedWeek: 1,
      basis: basisOf(Object.fromEntries(ROLES.map((r) => [r, 1]))),
    });
    for (const action of ['pause', 'resume'] as const) {
      const res = await facilitatorPost(table, action);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('session.already_ended');
    }
  });
});

describe('setCommitMode（PUT /sessions/{sessionId}/commit-mode）', () => {
  it('自動へ切り替え、4 役割がそろえば同じ操作の中で確定する', async () => {
    await boot();
    const table = await startedTable(app);
    const res = await setMode(table, 'AUTO');
    expect(res.statusCode).toBe(200);
    expectConforms('CommandResponse', res.json());
    await saveAllOverHttp(table);
    const state = await server.inject({
      method: 'GET',
      url: `/api/v1/sessions/${table.gameId}/state`,
      headers: { cookie: `bg_session=${table.facilitator}` },
    });
    expect(state.json().week).toBe(2);
  });

  it('変えた確定方式は、ゲームの状態とロビーに反映される（開始後の値は session が持つ）', async () => {
    await boot();
    const table = await startedTable(app);
    expect((await setMode(table, 'AUTO')).statusCode).toBe(200);
    for (const path of ['state', 'lobby']) {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/games/${table.gameId}/${path}`,
        headers: { cookie: `bg_session=${table.facilitator}` },
      });
      expect(res.json().commitMode).toBe('AUTO');
    }
  });

  it('停止中も変えられる。未知の方式は 422（field は commitMode）。進行役でなければ 403', async () => {
    await boot();
    const table = await startedTable(app);
    await facilitatorPost(table, 'pause');
    expect((await setMode(table, 'AUTO')).statusCode).toBe(200);
    const bad = await setMode(table, 'SOMETIMES');
    expect(bad.statusCode).toBe(422);
    expectConforms('ValidationProblemBody', bad.json());
    expect(bad.json().errors[0].field).toBe('commitMode');
    const player = await send(
      'PUT',
      `/api/v1/sessions/${table.gameId}/commit-mode`,
      table.players.RETAILER.token,
      { commitMode: 'MANUAL' },
    );
    expect(player.statusCode).toBe(403);
  });
});

describe('submitProxyDecision（PUT /sessions/{sessionId}/proxy-decisions/{role}）', () => {
  it('進行役が代理入力する（停止中も受け付け、版は 1 増える。入力者は代理入力）', async () => {
    await boot();
    const table = await startedTable(app);
    await facilitatorPost(table, 'pause');
    const res = await proxy(table, 'FACTORY', {
      requestedWeek: 1,
      quantity: 8,
    });
    expect(res.statusCode).toBe(200);
    expectConforms('CommandResponse', res.json());
    const state = await server.inject({
      method: 'GET',
      url: `/api/v1/sessions/${table.gameId}/state?role=FACTORY`,
      headers: { cookie: `bg_session=${table.facilitator}` },
    });
    const status = state.json().roles.FACTORY;
    expect(status).toMatchObject({ decision: 8, decisionVersion: 1 });
    expect(status.decisionEditor).toMatchObject({
      kind: 'FACILITATOR_PROXY',
      isSelf: true,
    });
  });

  it('週が違えば 409 session.week_advanced。進行役でなければ 403。役割が不正なら 422', async () => {
    await boot();
    const table = await startedTable(app);
    const stale = await proxy(table, 'FACTORY', {
      requestedWeek: 2,
      quantity: 8,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'session.week_advanced',
      requestedWeek: 2,
      currentWeek: 1,
    });
    const player = await proxy(
      table,
      'FACTORY',
      { requestedWeek: 1, quantity: 8 },
      table.players.FACTORY.token,
    );
    expect(player.statusCode).toBe(403);
    const role = await proxy(table, 'CUSTOMER', {
      requestedWeek: 1,
      quantity: 8,
    });
    expect(role.statusCode).toBe(422);
    expect(role.json().errors[0].field).toBe('role');
  });

  it('保存回数に数える（9 回まで。10 回目は session.save_limit_reached）。終了後は session.already_ended', async () => {
    await boot();
    const table = await startedTable(app, { weeks: 1 });
    for (let i = 0; i < 9; i++) {
      const res = await proxy(table, 'FACTORY', {
        requestedWeek: 1,
        quantity: i,
      });
      expect(res.statusCode).toBe(200);
    }
    const over = await proxy(table, 'FACTORY', {
      requestedWeek: 1,
      quantity: 3,
    });
    expect(over.statusCode).toBe(409);
    expect(over.json().code).toBe('session.save_limit_reached');
  });

  it('範囲外の数量は 422（field は quantity）', async () => {
    await boot();
    const table = await startedTable(app);
    const res = await proxy(table, 'FACTORY', {
      requestedWeek: 1,
      quantity: 5000,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0].field).toBe('quantity');
  });
});
