import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Application } from '../../src/application/index.js';
import { ROLES } from '../../src/domain/role.js';
import { bootApp } from './boot.js';
import {
  endedTable,
  observerOf,
  playWeek,
  preparedTable,
  saveAll,
  startedTable,
} from './fixtures.js';
import { expectConforms } from './spec.js';

// 読み取りの操作（段階 2）が、共有の契約のスキーマに適合し、契約が定める開示・認可の規則を守る

let server: FastifyInstance;
let app: Application;
beforeEach(async () => {
  ({ server, app } = await bootApp());
});
afterEach(async () => {
  await server.close();
});

const get = (
  url: string,
  token?: string,
  headers: Record<string, string> = {},
) =>
  server.inject({
    method: 'GET',
    url,
    headers: {
      ...(token ? { cookie: `bg_session=${token}` } : {}),
      ...headers,
    },
  });

const UNKNOWN = '00000000-0000-4000-8000-000000000000';

/** 資格の失敗は、無い・無効・別のゲーム・存在しないゲームを区別しない、同じ 403 */
async function expectUnauthorized(url: string, token?: string) {
  const res = await get(url, token);
  expect(res.statusCode, url).toBe(403);
  expect(res.headers['content-type']).toContain('application/problem+json');
  const body = res.json();
  expectConforms('Problem', body);
  expect(body.code).toBe('app.unauthorized');
  return body;
}

describe('getGameState（GET /games/{gameId}/state）', () => {
  it('進行役には、参加コードと最終週を返す。開始前は sessionId が null', async () => {
    const t = await preparedTable(app, { weeks: 3 });
    const res = await get(`/api/v1/games/${t.gameId}/state`, t.facilitator);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectConforms('GameState', body);
    expect(body).toMatchObject({
      gameId: t.gameId,
      sessionId: null,
      status: 'PREPARING',
      settingsKind: 'KIT',
      changedSettings: [],
      commitMode: 'MANUAL',
      joinCode: t.joinCode,
      finalWeek: 3,
    });
    expect(body.participantId).toBeUndefined();
    expect(body.versions.session).toBeNull();
    expect(typeof body.versions.game).toBe('number');
  });

  it('参加者には、自分の ID と役割を返す（参加コードと最終週は返さない）。開始後は sessionId が gameId', async () => {
    const t = await startedTable(app);
    const res = await get(
      `/api/v1/games/${t.gameId}/state`,
      t.players.WHOLESALER.token,
    );
    const body = res.json();
    expectConforms('GameState', body);
    expect(body).toMatchObject({
      status: 'STARTED',
      sessionId: t.gameId,
      participantId: t.players.WHOLESALER.participantId,
      role: 'WHOLESALER',
    });
    expect(body.joinCode).toBeUndefined();
    expect(body.finalWeek).toBeUndefined();
    expect(typeof body.versions.session).toBe('number');
  });

  it('資格が無い・無効・別のゲーム・存在しないゲームは、同じ 403。UUID でない ID は 404', async () => {
    const a = await preparedTable(app);
    const b = await preparedTable(app);
    await expectUnauthorized(`/api/v1/games/${a.gameId}/state`);
    await expectUnauthorized(
      `/api/v1/games/${a.gameId}/state`,
      'invalid-token',
    );
    await expectUnauthorized(`/api/v1/games/${a.gameId}/state`, b.facilitator);
    await expectUnauthorized(`/api/v1/games/${UNKNOWN}/state`, a.facilitator);
    const res = await get('/api/v1/games/not-a-uuid/state', a.facilitator);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('request.not_found');
  });

  it('X-Tab-Id があれば、Cookie 名は bg_session_<X-Tab-Id>', async () => {
    const t = await preparedTable(app);
    const tab = 'abcdefgh12345678';
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/games/${t.gameId}/state`,
      headers: {
        cookie: `bg_session_${tab}=${t.facilitator}`,
        'x-tab-id': tab,
      },
    });
    expect(res.statusCode).toBe(200);
    // タブ名なしの Cookie は、タブ ID つきの要求では読まない（別のタブの資格と混ざらない）
    const plain = await server.inject({
      method: 'GET',
      url: `/api/v1/games/${t.gameId}/state`,
      headers: { cookie: `bg_session=${t.facilitator}`, 'x-tab-id': tab },
    });
    expect(plain.statusCode).toBe(403);
  });
});

describe('getLobby（GET /games/{gameId}/lobby）', () => {
  it('進行役に、参加者・招待・観察者の一覧を返す', async () => {
    const t = await preparedTable(app);
    await observerOf(app, t);
    const res = await get(`/api/v1/games/${t.gameId}/lobby`, t.facilitator);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectConforms('Lobby', body);
    expect(body.joinCode).toBe(t.joinCode);
    expect(body.participants).toHaveLength(4);
    expect(
      body.participants.map((p: { role: string }) => p.role).sort(),
    ).toEqual([...ROLES].sort());
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0].revoked).toBe(false);
    expect(body.observers).toHaveLength(1);
    expect(body.observers[0].displayName).toBe('見学者');
    // 招待コードの値は含まない
    expect(JSON.stringify(body)).not.toMatch(/code"?\s*:\s*"(?!JOIN)/i);
  });

  it('参加者・観察者・無資格には開かない（同じ 403）', async () => {
    const t = await preparedTable(app);
    const observer = await observerOf(app, t);
    const url = `/api/v1/games/${t.gameId}/lobby`;
    await expectUnauthorized(url, t.players.RETAILER.token);
    await expectUnauthorized(url, observer);
    await expectUnauthorized(url);
  });
});

describe('getSessionState（GET /sessions/{sessionId}/state）', () => {
  it('開始前は、409 session.not_active', async () => {
    const t = await preparedTable(app);
    const res = await get(`/api/v1/sessions/${t.gameId}/state`, t.facilitator);
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expectConforms('Problem', body);
    expect(body.code).toBe('session.not_active');
  });

  it('参加者には自分の役割の状況だけを返す。小売店だけ顧客需要を含む', async () => {
    const t = await startedTable(app, { demand: [7, 7] });
    const retailer = await get(
      `/api/v1/sessions/${t.gameId}/state`,
      t.players.RETAILER.token,
    );
    expect(retailer.statusCode).toBe(200);
    const r = retailer.json();
    expectConforms('SessionState', r);
    expect(r).toMatchObject({
      sessionId: t.gameId,
      status: 'ACTIVE',
      week: 1,
      submittedRoleCount: 0,
      role: 'RETAILER',
      participantId: t.players.RETAILER.participantId,
    });
    expect(r.roleStatus.customerDemand).toBe(7);
    expect(r.roleStatus.orders).toBe(7);
    expect(r.roleStatus.decision).toBeNull();
    expect(r.roleStatus.decisionEditor).toBeNull();
    expect(r.roleStatus.decisionSavedAt).toBeNull();
    // 進行役向けの項目と、他の役割の値は含まない
    expect(r.roles).toBeUndefined();
    expect(r.results).toBeUndefined();
    expect(r.finalWeek).toBeUndefined();
    // 将来の週の需要は、どこにも含まない
    expect(JSON.stringify(r)).not.toContain('demand');

    const factory = (
      await get(`/api/v1/sessions/${t.gameId}/state`, t.players.FACTORY.token)
    ).json();
    expectConforms('SessionState', factory);
    expect(factory.roleStatus.customerDemand).toBeUndefined();
    // 同じ役割の共同担当（自分を含む）。参加者の ID は含めない
    expect(factory.coHolders).toEqual([
      { displayName: '参加者-FACTORY', isSelf: true },
    ]);
  });

  it('入力を保存すると、保存者・保存の時刻・版を示す。確定後は結果に反映される', async () => {
    const t = await startedTable(app);
    await app.saveDecision({
      token: t.players.RETAILER.token,
      gameId: t.gameId,
      role: 'RETAILER',
      quantity: 9,
      expectedVersion: 0,
    });
    const own = (
      await get(`/api/v1/sessions/${t.gameId}/state`, t.players.RETAILER.token)
    ).json();
    expectConforms('SessionState', own);
    expect(own.roleStatus).toMatchObject({ decision: 9, decisionVersion: 1 });
    expect(own.roleStatus.decisionEditor).toEqual({
      kind: 'PARTICIPANT',
      displayName: '参加者-RETAILER',
      isSelf: true,
    });
    expect(Number.isNaN(Date.parse(own.roleStatus.decisionSavedAt))).toBe(
      false,
    );
    expect(own.submittedRoleCount).toBe(1);

    // 進行役の代理入力は、表示名を持たない
    await app.proxyDecision({
      token: t.facilitator,
      gameId: t.gameId,
      role: 'FACTORY',
      quantity: 3,
      expectedVersion: 0,
    });
    const fac = (
      await get(`/api/v1/sessions/${t.gameId}/state`, t.facilitator)
    ).json();
    expectConforms('SessionState', fac);
    expect(fac.roles.FACTORY.decisionEditor).toEqual({
      kind: 'FACILITATOR_PROXY',
      displayName: null,
      isSelf: true,
    });
    expect(fac.roles.RETAILER.decisionEditor.isSelf).toBe(false);
  });

  it('進行役には、全役割の状況と、確定した週の結果を返す', async () => {
    const t = await startedTable(app, { weeks: 2 });
    await playWeek(app, t, 1);
    const res = await get(`/api/v1/sessions/${t.gameId}/state`, t.facilitator);
    const body = res.json();
    expectConforms('SessionState', body);
    expect(Object.keys(body.roles).sort()).toEqual([...ROLES].sort());
    expect(body.finalWeek).toBe(2);
    expect(body.week).toBe(2);
    // 確定した週 1 の、4 役割分（上流から下流）
    expect(body.results.map((r: { role: string }) => r.role)).toEqual([
      ...ROLES,
    ]);
    expect(body.results.every((r: { week: number }) => r.week === 1)).toBe(
      true,
    );
    expect(body.roleStatus).toBeUndefined();
  });

  it('自分と違う役割（role）を求めたら、値を返さずに 403。役割の 4 値以外は 422（field は role）', async () => {
    const t = await startedTable(app);
    const url = `/api/v1/sessions/${t.gameId}/state`;
    await expectUnauthorized(`${url}?role=FACTORY`, t.players.RETAILER.token);
    const ok = await get(`${url}?role=RETAILER`, t.players.RETAILER.token);
    expect(ok.statusCode).toBe(200);
    const bad = await get(`${url}?role=NOPE`, t.players.RETAILER.token);
    expect(bad.statusCode).toBe(422);
    const body = bad.json();
    expectConforms('ValidationProblemBody', body);
    expect(body.errors[0].field).toBe('role');
  });

  it('観察者・無資格には開かない', async () => {
    const t = await startedTable(app);
    const observer = await observerOf(app, t);
    await expectUnauthorized(`/api/v1/sessions/${t.gameId}/state`, observer);
    await expectUnauthorized(`/api/v1/sessions/${t.gameId}/state`);
  });
});

describe('getObservation（GET /games/{gameId}/observation）', () => {
  it('観察者と進行役に、現在週・入力済みの役割数・チーム合計だけを返す', async () => {
    const t = await startedTable(app, { weeks: 2 });
    await playWeek(app, t, 1);
    await saveAll(app, t);
    const observer = await observerOf(app, t);
    for (const token of [observer, t.facilitator]) {
      const res = await get(`/api/v1/games/${t.gameId}/observation`, token);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expectConforms('Observation', body);
      expect(body).toMatchObject({
        gameId: t.gameId,
        status: 'STARTED',
        finalWeek: 2,
        sessionStatus: 'ACTIVE',
        week: 2,
        submittedRoleCount: 4,
      });
      expect(body.totals.policy).toBe('TEAM_TOTAL');
      expect(body.totals.weeks).toHaveLength(1);
      expect(body.totals.weeks[0]).toMatchObject({ week: 1 });
      // 役割別の値・入力者・参加コードは含まない
      const text = JSON.stringify(body);
      for (const role of ROLES) expect(text).not.toContain(role);
      expect(text).not.toContain(t.joinCode);
    }
  });

  it('開始前も開ける（現在週などは付かない）', async () => {
    const t = await preparedTable(app);
    const res = await get(
      `/api/v1/games/${t.gameId}/observation`,
      t.facilitator,
    );
    const body = res.json();
    expectConforms('Observation', body);
    expect(body.status).toBe('PREPARING');
    expect(body.sessionStatus).toBeUndefined();
  });

  it('公開範囲が「なし」なら、合計を出さず、理由を示す', async () => {
    const created = await app.createGame({
      weeks: 1,
      demand: [4],
      conditions: { disclosure: 'PROGRESS_ONLY' },
    });
    const res = await get(
      `/api/v1/games/${created.gameId}/observation`,
      created.facilitatorToken,
    );
    const body = res.json();
    expectConforms('Observation', body);
    expect(body.totals).toEqual({
      policy: 'NONE',
      hiddenReason: 'DISCLOSURE_NONE',
      weeks: [],
    });
  });

  it('参加者・無資格には開かない', async () => {
    const t = await startedTable(app);
    await expectUnauthorized(
      `/api/v1/games/${t.gameId}/observation`,
      t.players.RETAILER.token,
    );
    await expectUnauthorized(`/api/v1/games/${t.gameId}/observation`);
  });
});

describe('getReview（GET /games/{gameId}/review）', () => {
  it('終了するまでは、409 game.not_ended で、値を一切返さない', async () => {
    const t = await startedTable(app);
    for (const token of [t.facilitator, t.players.RETAILER.token]) {
      const res = await get(`/api/v1/games/${t.gameId}/review`, token);
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expectConforms('Problem', body);
      expect(body.code).toBe('game.not_ended');
      expect(body.results).toBeUndefined();
    }
  });

  it('終了後は、進行役・参加者・観察者に、全役割の全週の結果を返す（週、役割は上流から下流）', async () => {
    const t = await endedTable(app, { weeks: 2 });
    const observer = await observerOf(app, t);
    for (const token of [t.facilitator, t.players.FACTORY.token, observer]) {
      const res = await get(`/api/v1/games/${t.gameId}/review`, token);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expectConforms('Review', body);
      expect(body).toMatchObject({
        gameId: t.gameId,
        finalWeek: 2,
        settingsKind: 'KIT',
        commitMode: 'MANUAL',
      });
      expect(
        body.results.map(
          (r: { week: number; role: string }) => `${r.week}:${r.role}`,
        ),
      ).toEqual(
        [1, 2].flatMap((week) => ROLES.map((role) => `${week}:${role}`)),
      );
    }
  });

  it('無資格には開かない', async () => {
    const t = await endedTable(app);
    await expectUnauthorized(`/api/v1/games/${t.gameId}/review`);
  });
});

describe('getExport（GET /games/{gameId}/exports）', () => {
  const HEADER =
    'schema_version,game_id,settings_kind,settings_changes,commit_mode,week,role,orders,shipped,ordered,ending_inventory,ending_backlog,weekly_cost_minor,cumulative_cost_minor';

  it('終了前は 409 game.not_ended', async () => {
    const t = await startedTable(app);
    const res = await get(
      `/api/v1/games/${t.gameId}/exports?format=csv`,
      t.facilitator,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('game.not_ended');
  });

  it('JSON は ExportDocument に適合し、チェックサムとスキーマ版をヘッダーで返す', async () => {
    const t = await endedTable(app, { weeks: 2 });
    const res = await get(
      `/api/v1/games/${t.gameId}/exports?format=json`,
      t.facilitator,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="beer-game-${t.gameId}.json"`,
    );
    const body = JSON.parse(res.body);
    expectConforms('ExportDocument', body);
    expect(body.schemaVersion).toBe('beer-game-kotlin.export.v1');
    expect(body.records).toHaveLength(2 * 4);
    expect(res.headers['x-export-schema-version']).toBe(body.schemaVersion);
    expect(res.headers['x-export-checksum']).toBe(
      `sha256-${createHash('sha256').update(res.body, 'utf8').digest('hex')}`,
    );
    // 表示名・参加コードは含めない（NF-S14）
    expect(res.body).not.toContain('参加者-');
    expect(res.body).not.toContain(t.joinCode);
  });

  it('CSV は契約の列で、RFC 4180（CRLF）。JSON と同じ値', async () => {
    const t = await endedTable(app, { weeks: 2 });
    const csv = await get(
      `/api/v1/games/${t.gameId}/exports?format=csv`,
      t.facilitator,
    );
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.split('\r\n');
    expect(lines.at(-1)).toBe('');
    expect(lines[0]).toBe(HEADER);
    expect(lines).toHaveLength(1 + 8 + 1);
    expect(
      lines[1]!.startsWith(
        `beer-game-kotlin.export.v1,${t.gameId},KIT,,MANUAL,1,FACTORY,`,
      ),
    ).toBe(true);
    const json = JSON.parse(
      (
        await get(
          `/api/v1/games/${t.gameId}/exports?format=json`,
          t.facilitator,
        )
      ).body,
    );
    const first = json.records[0];
    expect(lines[1]!.split(',').slice(5)).toEqual(
      [
        first.week,
        first.role,
        first.orders,
        first.shipped,
        first.ordered,
        first.endingInventory,
        first.endingBacklog,
        first.weeklyCostMinor,
        first.cumulativeCostMinor,
      ].map(String),
    );
  });

  it('format は必須で、知らない形式は 422（field は format）', async () => {
    const t = await endedTable(app);
    for (const query of ['', '?format=xml']) {
      const res = await get(
        `/api/v1/games/${t.gameId}/exports${query}`,
        t.facilitator,
      );
      expect(res.statusCode).toBe(422);
      const body = res.json();
      expectConforms('ValidationProblemBody', body);
      expect(body.errors[0].field).toBe('format');
    }
  });

  it('進行役だけ。参加者・観察者・無資格は同じ 403', async () => {
    const t = await endedTable(app);
    const observer = await observerOf(app, t);
    const url = `/api/v1/games/${t.gameId}/exports?format=csv`;
    await expectUnauthorized(url, t.players.RETAILER.token);
    await expectUnauthorized(url, observer);
    await expectUnauthorized(url);
  });
});

describe('getRetention（GET /games/{gameId}/retention）', () => {
  it('進行役に、保持日数・削除予定日・削除の進行を返す', async () => {
    const created = await app.createGame({
      weeks: 1,
      demand: [4],
      retentionDays: 30,
    });
    const res = await get(
      `/api/v1/games/${created.gameId}/retention`,
      created.facilitatorToken,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectConforms('Retention', body);
    expect(body).toMatchObject({
      retentionDays: 30,
      status: 'SCHEDULED',
      attempt: 0,
      nextAttemptAt: null,
      lastFailureCode: null,
      backupRetentionDays: 7,
    });
    expect(
      Date.parse(body.deleteAfter) - Date.parse(body.startsAt),
    ).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  });

  it('進行役だけ。参加者・無資格は同じ 403', async () => {
    const t = await preparedTable(app);
    await expectUnauthorized(
      `/api/v1/games/${t.gameId}/retention`,
      t.players.RETAILER.token,
    );
    await expectUnauthorized(`/api/v1/games/${t.gameId}/retention`);
  });
});
