import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Application } from '../../src/application/index.js';
import { ROLES } from '../../src/domain/role.js';
import { bootApp, ORIGIN } from './boot.js';
import { preparedTable, startedTable } from './fixtures.js';
import { expectConforms } from './spec.js';

// 準備中のコマンド（createGame・joinGame・startGame・assignRole）が、共有の契約に適合し、契約の規則を守る

let server: FastifyInstance;
let app: Application;
afterEach(async () => {
  await server?.close();
});
async function boot(options: Parameters<typeof bootApp>[0] = {}) {
  ({ server, app } = await bootApp(options));
}

interface Sent {
  cookie?: string;
  key?: string | null;
  headers?: Record<string, string>;
}
const send = (
  method: 'POST' | 'PUT',
  url: string,
  payload: unknown,
  { cookie, key = randomUUID(), headers = {} }: Sent = {},
) =>
  server.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: {
      origin: ORIGIN,
      ...(key === null ? {} : { 'idempotency-key': key }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
  });
const session = (token: string) => `bg_session=${token}`;
const get = (url: string, token: string) =>
  server.inject({ method: 'GET', url, headers: { cookie: session(token) } });

/** 応答の Set-Cookie を、名前ごとにまとめる */
function cookiesOf(res: { cookies: Array<Record<string, unknown>> }) {
  return Object.fromEntries(res.cookies.map((c) => [c.name as string, c]));
}

const KIT_REQUEST = { kind: 'KIT', finalWeek: 3, demand: [4, 4, 4] };

describe('createGame（POST /games）', () => {
  it('201 で、versions と復帰コードを返し、Location に状態の URL を示し、進行役の資格を Cookie で発行する', async () => {
    await boot();
    const res = await send('POST', '/api/v1/games', KIT_REQUEST);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expectConforms('CreateGameResponse', body);
    expect(body.versions).toEqual({ game: 0, session: null });
    expect(typeof body.recoveryCode).toBe('string');
    const gameId = /\/games\/([^/]+)\/state$/.exec(
      res.headers.location as string,
    )?.[1];
    expect(gameId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.location).toBe(`/api/v1/games/${gameId}/state`);

    const cookies = cookiesOf(res);
    expect(cookies.bg_session).toMatchObject({
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 86_400,
    });
    expect(cookies.bg_recovery).toMatchObject({
      httpOnly: true,
      sameSite: 'Strict',
      path: '/api/v1/participations/recover',
      maxAge: 2_592_000,
      value: body.recoveryCode,
    });
    // 発行した資格で、進行役としてゲームを読める
    const state = await get(
      `/api/v1/games/${gameId}/state`,
      cookies.bg_session!.value as string,
    );
    expect(state.statusCode).toBe(200);
    expect(state.json().joinCode).toBeTruthy();
  });

  it('HTTPS の環境では、Cookie に Secure を付ける（設定）。X-Tab-Id があれば、Cookie の名前はタブ別', async () => {
    await boot({ secureCookies: true });
    const tab = 'abcdefgh12345678';
    const res = await send('POST', '/api/v1/games', KIT_REQUEST, {
      headers: { 'x-tab-id': tab },
    });
    const cookies = cookiesOf(res);
    expect(cookies[`bg_session_${tab}`]).toMatchObject({ secure: true });
    expect(cookies[`bg_recovery_${tab}`]).toMatchObject({ secure: true });
    expect(cookies.bg_session).toBeUndefined();
  });

  it('同じキー・同じ内容の再送は、同じゲームと同じ資格・復帰コードを返す。内容が違えば 409', async () => {
    await boot();
    const key = randomUUID();
    const a = await send('POST', '/api/v1/games', KIT_REQUEST, { key });
    const b = await send('POST', '/api/v1/games', KIT_REQUEST, { key });
    expect(b.statusCode).toBe(201);
    expect(b.headers.location).toBe(a.headers.location);
    expect(b.json()).toEqual(a.json());
    expect(cookiesOf(b).bg_session!.value).toBe(cookiesOf(a).bg_session!.value);

    const reused = await send(
      'POST',
      '/api/v1/games',
      { ...KIT_REQUEST, finalWeek: 2, demand: [4, 4] },
      { key },
    );
    expect(reused.statusCode).toBe(409);
    const problem = reused.json();
    expectConforms('Problem', problem);
    expect(problem.code).toBe('app.idempotency_key_reused');
  });

  it('カスタム条件で作る（役割ごとの初期在庫・初期の流れ・公開範囲 NONE）。状態に、種別と変えた項目が出る', async () => {
    await boot();
    const res = await send('POST', '/api/v1/games', {
      kind: 'CUSTOM',
      finalWeek: 3,
      demand: [4, 4, 4],
      commitMode: 'AUTO',
      retentionDays: 30,
      conditions: {
        initialInventory: { RETAILER: 20 },
        initialFlow: 5,
        shipmentDelayWeeks: 3,
        disclosurePolicy: 'NONE',
      },
    });
    expect(res.statusCode).toBe(201);
    const gameId = /\/games\/([^/]+)\/state$/.exec(
      res.headers.location as string,
    )![1];
    const state = (
      await get(
        `/api/v1/games/${gameId}/state`,
        cookiesOf(res).bg_session!.value as string,
      )
    ).json();
    expectConforms('GameState', state);
    expect(state).toMatchObject({
      settingsKind: 'CUSTOM',
      commitMode: 'AUTO',
      changedSettings: [
        'INITIAL_INVENTORY',
        'INITIAL_FLOW',
        'SHIPMENT_DELAY',
        'DISCLOSURE',
      ],
    });
  });

  it('入力の誤りは、すべて集めて 422（項目ごとに field・修正内容。需要は対象の週つき）', async () => {
    await boot();
    const res = await send('POST', '/api/v1/games', {
      kind: 'CUSTOM',
      finalWeek: 3,
      demand: [4, -2, 'x'],
      retentionDays: 99_999,
      conditions: { shipmentDelayWeeks: 9, initialInventory: { FACTORY: -1 } },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expectConforms('ValidationProblemBody', body);
    expect(body.code).toBe('validation.invalid_input');
    const fields = body.errors.map((e: { field: string }) => e.field);
    expect(fields).toContain('demand');
    expect(fields).toContain('conditions.shipmentDelayWeeks');
    expect(fields).toContain('conditions.initialInventory.FACTORY');
    // 需要の誤りは、対象の週を示す
    expect(
      body.errors
        .filter((e: { field: string }) => e.field === 'demand')
        .map((e: { week: number }) => e.week),
    ).toEqual([2, 3]);
  });

  it('最終週の範囲外・小数・文字は 422（field は finalWeek）。KIT に条件を付けると 422（field は conditions）', async () => {
    await boot();
    for (const finalWeek of [0, 51, 3.5, 'x']) {
      const res = await send('POST', '/api/v1/games', {
        ...KIT_REQUEST,
        finalWeek,
      });
      expect(res.statusCode, String(finalWeek)).toBe(422);
      expect(
        res.json().errors.map((e: { field: string }) => e.field),
      ).toContain('finalWeek');
    }
    const kitWithConditions = await send('POST', '/api/v1/games', {
      ...KIT_REQUEST,
      conditions: { initialFlow: 5 },
    });
    expect(kitWithConditions.statusCode).toBe(422);
    expect(kitWithConditions.json().errors[0].field).toBe('conditions');
    const badKind = await send('POST', '/api/v1/games', {
      ...KIT_REQUEST,
      kind: 'OTHER',
    });
    expect(badKind.statusCode).toBe(422);
    expect(badKind.json().errors[0].field).toBe('kind');
  });

  it('JSON として不正な本文は 400。Idempotency-Key が無ければ 400', async () => {
    await boot();
    const broken = await server.inject({
      method: 'POST',
      url: '/api/v1/games',
      payload: '{nope',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': 'k',
      },
    });
    expect(broken.statusCode).toBe(400);
    const noKey = await send('POST', '/api/v1/games', KIT_REQUEST, {
      key: null,
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().code).toBe('validation.invalid_input');
  });
});

describe('joinGame（POST /participations/join）', () => {
  it('200 で、versions と gameId を返し、参加者の資格を Cookie で発行する（復帰資格つき）', async () => {
    await boot();
    const created = await app.createGame({ weeks: 2, demand: [4, 4] });
    const res = await send('POST', '/api/v1/participations/join', {
      joinCode: created.joinCode,
      displayName: '田中',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectConforms('JoinResponse', body);
    expect(body.gameId).toBe(created.gameId);
    expect(body.versions.game).toBeGreaterThan(0);
    const cookies = cookiesOf(res);
    expect(cookies.bg_session).toBeTruthy();
    expect(cookies.bg_recovery).toMatchObject({
      path: '/api/v1/participations/recover',
    });
    // 参加者の資格で、自分の ID を読める。参加コード・最終週は読めない
    const state = (
      await get(
        `/api/v1/games/${created.gameId}/state`,
        cookies.bg_session!.value as string,
      )
    ).json();
    expect(state.participantId).toBeTruthy();
    expect(state.joinCode).toBeUndefined();
  });

  it('不明・形式不正の参加コードは、区別せず 403（game.invitation_invalid）', async () => {
    await boot();
    for (const joinCode of ['NOPE-0000', '', 'a'.repeat(300)]) {
      const res = await send('POST', '/api/v1/participations/join', {
        joinCode,
        displayName: '田中',
      });
      expect(res.statusCode, joinCode).toBe(403);
      const body = res.json();
      expectConforms('Problem', body);
      expect(body.code).toBe('game.invitation_invalid');
    }
  });

  it('開始済みのゲームへの参加は 409（game.not_preparing）', async () => {
    await boot();
    const t = await startedTable(app);
    const res = await send('POST', '/api/v1/participations/join', {
      joinCode: t.joinCode,
      displayName: '遅刻',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('game.not_preparing');
  });

  it('表示名が空・長すぎるときは 422（field は displayName）', async () => {
    await boot();
    const created = await app.createGame({ weeks: 2, demand: [4, 4] });
    for (const displayName of ['', '  ', 'あ'.repeat(81)]) {
      const res = await send('POST', '/api/v1/participations/join', {
        joinCode: created.joinCode,
        displayName,
      });
      expect(res.statusCode).toBe(422);
      expectConforms('ValidationProblemBody', res.json());
      expect(res.json().errors[0].field).toBe('displayName');
    }
  });

  it('同じキー・同じ内容の再送は、同じ参加者・同じ資格を返し、参加者を増やさない', async () => {
    await boot();
    const created = await app.createGame({ weeks: 2, demand: [4, 4] });
    const key = randomUUID();
    const request = { joinCode: created.joinCode, displayName: '田中' };
    const a = await send('POST', '/api/v1/participations/join', request, {
      key,
    });
    const b = await send('POST', '/api/v1/participations/join', request, {
      key,
    });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(cookiesOf(b).bg_session!.value).toBe(cookiesOf(a).bg_session!.value);
    const lobby = (
      await get(
        `/api/v1/games/${created.gameId}/lobby`,
        created.facilitatorToken,
      )
    ).json();
    expect(lobby.participants).toHaveLength(1);
    // 内容が違えば 409
    const reused = await send(
      'POST',
      '/api/v1/participations/join',
      { ...request, displayName: '別人' },
      { key },
    );
    expect(reused.statusCode).toBe(409);
    expect(reused.json().code).toBe('app.idempotency_key_reused');
  });

  it('試行が多すぎると 429（app.rate_limited）と Retry-After', async () => {
    await boot({ rateLimit: 2 });
    const created = await app.createGame({ weeks: 2, demand: [4, 4] });
    const attempt = () =>
      send('POST', '/api/v1/participations/join', {
        joinCode: created.joinCode,
        displayName: '田中',
      });
    expect((await attempt()).statusCode).toBe(200);
    expect((await attempt()).statusCode).toBe(200);
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expectConforms('Problem', limited.json());
    expect(limited.json().code).toBe('app.rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('startGame（POST /games/{gameId}/start）', () => {
  it('進行役が開始する。versions に、セッションの版が出る', async () => {
    await boot();
    const t = await preparedTable(app);
    const res = await send(
      'POST',
      `/api/v1/games/${t.gameId}/start`,
      undefined,
      {
        cookie: session(t.facilitator),
      },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectConforms('CommandResponse', body);
    expect(body.versions.session).toBe(0);
    const state = (
      await get(`/api/v1/games/${t.gameId}/state`, t.facilitator)
    ).json();
    expect(state.status).toBe('STARTED');
    expect(state.versions).toEqual(body.versions);
  });

  it('役割が足りなければ 409（game.start_condition_not_met）と、不足する役割。何も作られない', async () => {
    await boot();
    const created = await app.createGame({ weeks: 2, demand: [4, 4] });
    const res = await send(
      'POST',
      `/api/v1/games/${created.gameId}/start`,
      undefined,
      {
        cookie: session(created.facilitatorToken),
      },
    );
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expectConforms('StartConditionProblemBody', body);
    expect(body.code).toBe('game.start_condition_not_met');
    expect([...body.missingRoles].sort()).toEqual([...ROLES].sort());
    const state = (
      await get(
        `/api/v1/games/${created.gameId}/state`,
        created.facilitatorToken,
      )
    ).json();
    expect(state.status).toBe('PREPARING');
  });

  it('二重の開始は 409（session.already_started）。同じキーの再送は、同じ応答', async () => {
    await boot();
    const t = await preparedTable(app);
    const key = randomUUID();
    const first = await send(
      'POST',
      `/api/v1/games/${t.gameId}/start`,
      undefined,
      {
        cookie: session(t.facilitator),
        key,
      },
    );
    const replay = await send(
      'POST',
      `/api/v1/games/${t.gameId}/start`,
      undefined,
      {
        cookie: session(t.facilitator),
        key,
      },
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const again = await send(
      'POST',
      `/api/v1/games/${t.gameId}/start`,
      undefined,
      {
        cookie: session(t.facilitator),
      },
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('session.already_started');
  });

  it('進行役だけ。参加者・無資格・別のゲームは、同じ 403（app.unauthorized）。ID が UUID でなければ 404', async () => {
    await boot();
    const t = await preparedTable(app);
    const other = await preparedTable(app);
    for (const cookie of [
      session(t.players.RETAILER.token),
      session('invalid'),
      session(other.facilitator),
      undefined,
    ]) {
      const res = await send(
        'POST',
        `/api/v1/games/${t.gameId}/start`,
        undefined,
        {
          ...(cookie ? { cookie } : {}),
        },
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('app.unauthorized');
    }
    const bad = await send(
      'POST',
      '/api/v1/games/not-a-uuid/start',
      undefined,
      {
        cookie: session(t.facilitator),
      },
    );
    expect(bad.statusCode).toBe(404);
  });
});

describe('assignRole（PUT /games/{gameId}/participants/{participantId}/role）', () => {
  async function lobbyRoles(gameId: string, token: string) {
    const lobby = (await get(`/api/v1/games/${gameId}/lobby`, token)).json();
    return Object.fromEntries(
      lobby.participants.map(
        (p: { participantId: string; role: string | null }) => [
          p.participantId,
          p.role,
        ],
      ),
    );
  }
  const assign = (
    gameId: string,
    participantId: string,
    role: unknown,
    cookie: string,
    key?: string,
  ) =>
    send(
      'PUT',
      `/api/v1/games/${gameId}/participants/${participantId}/role`,
      { role },
      { cookie, ...(key ? { key } : {}) },
    );

  it('進行役が割り当てる。versions を返し、ロビーに反映される', async () => {
    await boot();
    const created = await app.createGame({ weeks: 2, demand: [4, 4] });
    const joined = await app.joinGame({
      joinCode: created.joinCode,
      displayName: '田中',
    });
    const res = await assign(
      created.gameId,
      joined.participantId,
      'RETAILER',
      session(created.facilitatorToken),
    );
    expect(res.statusCode).toBe(200);
    expectConforms('CommandResponse', res.json());
    expect(
      (await lobbyRoles(created.gameId, created.facilitatorToken))[
        joined.participantId
      ],
    ).toBe('RETAILER');
  });

  it('別の役割にいる人は、付け替え（D9）になる。同じ役割への割り当て直しは、何も変わらず、版も進まない', async () => {
    await boot();
    const created = await app.createGame({ weeks: 2, demand: [4, 4] });
    const joined = await app.joinGame({
      joinCode: created.joinCode,
      displayName: '田中',
    });
    const cookie = session(created.facilitatorToken);
    const first = await assign(
      created.gameId,
      joined.participantId,
      'RETAILER',
      cookie,
    );
    const moved = await assign(
      created.gameId,
      joined.participantId,
      'FACTORY',
      cookie,
    );
    expect(moved.statusCode).toBe(200);
    expect(
      (await lobbyRoles(created.gameId, created.facilitatorToken))[
        joined.participantId
      ],
    ).toBe('FACTORY');
    const same = await assign(
      created.gameId,
      joined.participantId,
      'FACTORY',
      cookie,
    );
    expect(same.statusCode).toBe(200);
    expect(same.json().versions).toEqual(moved.json().versions);
    expect(moved.json().versions.game).toBeGreaterThan(
      first.json().versions.game,
    );
  });

  it('存在しない参加者は 404（game.participant_not_found）。役割の 4 値以外は 422（field は role）', async () => {
    await boot();
    const created = await app.createGame({ weeks: 2, demand: [4, 4] });
    const cookie = session(created.facilitatorToken);
    const unknown = await assign(
      created.gameId,
      randomUUID(),
      'RETAILER',
      cookie,
    );
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('game.participant_not_found');
    const joined = await app.joinGame({
      joinCode: created.joinCode,
      displayName: '田中',
    });
    const bad = await assign(
      created.gameId,
      joined.participantId,
      'NOPE',
      cookie,
    );
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0].field).toBe('role');
  });

  it('進行役だけ。参加者・無資格は、同じ 403', async () => {
    await boot();
    const t = await preparedTable(app);
    const target = t.players.FACTORY.participantId;
    for (const cookie of [
      session(t.players.RETAILER.token),
      session('invalid'),
    ]) {
      const res = await assign(t.gameId, target, 'RETAILER', cookie);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('app.unauthorized');
    }
  });

  it('開始後に、別の役割へ付け替えようとすると 409（game.not_preparing）', async () => {
    await boot();
    const t = await startedTable(app);
    const res = await assign(
      t.gameId,
      t.players.FACTORY.participantId,
      'RETAILER',
      session(t.facilitator),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('game.not_preparing');
  });

  it('同じキーの再送は、保存した応答（付け替えの二重適用をしない）', async () => {
    await boot();
    const created = await app.createGame({ weeks: 2, demand: [4, 4] });
    const joined = await app.joinGame({
      joinCode: created.joinCode,
      displayName: '田中',
    });
    const key = randomUUID();
    const cookie = session(created.facilitatorToken);
    const a = await assign(
      created.gameId,
      joined.participantId,
      'RETAILER',
      cookie,
      key,
    );
    const b = await assign(
      created.gameId,
      joined.participantId,
      'RETAILER',
      cookie,
      key,
    );
    expect(b.json()).toEqual(a.json());
    const other = await assign(
      created.gameId,
      joined.participantId,
      'FACTORY',
      cookie,
      key,
    );
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe('app.idempotency_key_reused');
  });
});
