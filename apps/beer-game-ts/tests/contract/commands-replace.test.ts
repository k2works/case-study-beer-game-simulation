import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Application } from '../../src/application/index.js';
import { ROLES } from '../../src/domain/role.js';
import { bootApp, ORIGIN } from './boot.js';
import { expectConforms } from './spec.js';

// 開始後の役割の入れ替え（H4。assignRole）が、共有の契約の規則を守る

let server: FastifyInstance;
let app: Application;
afterEach(async () => {
  await server?.close();
});

interface Table {
  gameId: string;
  facilitator: string;
  players: Record<(typeof ROLES)[number], { id: string; token: string }>;
  /** 開始前に参加し、役割を持たなかった参加者 */
  spare: { id: string; token: string; recoveryCode: string };
}

/** 5 人が参加して 4 人が 4 役割に割り当てられ、開始している。1 人は役割を持たない */
async function startedWithSpare(weeks = 2): Promise<Table> {
  ({ server, app } = await bootApp());
  const created = await app.createGame({
    weeks,
    demand: Array.from({ length: weeks }, () => 4),
  });
  const players = {} as Table['players'];
  for (const role of ROLES) {
    const joined = await app.joinGame({
      joinCode: created.joinCode,
      displayName: `担当-${role}`,
    });
    await app.assignRole({
      token: created.facilitatorToken,
      gameId: created.gameId,
      participantId: joined.participantId,
      role,
    });
    players[role] = { id: joined.participantId, token: joined.token };
  }
  const extra = await app.joinGame({
    joinCode: created.joinCode,
    displayName: '交代要員',
  });
  await app.startGame({
    token: created.facilitatorToken,
    gameId: created.gameId,
  });
  return {
    gameId: created.gameId,
    facilitator: created.facilitatorToken,
    players,
    spare: {
      id: extra.participantId,
      token: extra.token,
      recoveryCode: extra.recoveryCode,
    },
  };
}

const assign = (
  table: Table,
  participantId: string,
  role: string,
  token = table.facilitator,
) =>
  server.inject({
    method: 'PUT',
    url: `/api/v1/games/${table.gameId}/participants/${participantId}/role`,
    payload: { role },
    headers: {
      origin: ORIGIN,
      cookie: `bg_session=${token}`,
      'idempotency-key': randomUUID(),
    },
  });
const get = (url: string, token: string) =>
  server.inject({
    method: 'GET',
    url,
    headers: { cookie: `bg_session=${token}` },
  });

describe('assignRole（開始後の入れ替え）', () => {
  it('担当のいる役割へ、未割り当ての参加者を割り当てると、旧担当者が外れ、game と session の版が進む', async () => {
    const table = await startedWithSpare();
    const before = await get(
      `/api/v1/games/${table.gameId}/state`,
      table.facilitator,
    );
    const res = await assign(table, table.spare.id, 'RETAILER');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectConforms('CommandResponse', body);
    expect(body.versions.game).toBe(before.json().versions.game + 1);
    expect(body.versions.session).toBe(before.json().versions.session + 1);

    const lobby = await get(
      `/api/v1/games/${table.gameId}/lobby`,
      table.facilitator,
    );
    expectConforms('Lobby', lobby.json());
    const rows = Object.fromEntries(
      lobby
        .json()
        .participants.map((p: { participantId: string }) => [
          p.participantId,
          p,
        ]),
    );
    expect(rows[table.spare.id]).toMatchObject({ role: 'RETAILER' });
    expect(rows[table.spare.id].replaced).toBeUndefined();
    expect(rows[table.players.RETAILER.id]).toMatchObject({
      role: null,
      replaced: true,
    });
  });

  it('旧担当者の資格は失効し（ブラウザセッションも復帰も）、新しい担当者が入力できる', async () => {
    const table = await startedWithSpare();
    await assign(table, table.spare.id, 'RETAILER');
    const old = await get(
      `/api/v1/sessions/${table.gameId}/state`,
      table.players.RETAILER.token,
    );
    expect(old.statusCode).toBe(403);
    expect(old.json().code).toBe('app.unauthorized');

    const state = await get(
      `/api/v1/sessions/${table.gameId}/state`,
      table.spare.token,
    );
    expect(state.statusCode).toBe(200);
    expectConforms('SessionState', state.json());
    expect(state.json().role).toBe('RETAILER');

    const save = await server.inject({
      method: 'PUT',
      url: `/api/v1/sessions/${table.gameId}/decisions`,
      payload: { week: 1, quantity: 5 },
      headers: {
        origin: ORIGIN,
        cookie: `bg_session=${table.spare.token}`,
        'idempotency-key': randomUUID(),
      },
    });
    expect(save.statusCode).toBe(200);
  });

  it('同じ役割への割り当て直しは、変化なしで 200（版を進めない）', async () => {
    const table = await startedWithSpare();
    const first = await assign(table, table.spare.id, 'RETAILER');
    const again = await assign(table, table.spare.id, 'RETAILER');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
  });

  it('開始後の別の役割にいる人の付け替えは 409 game.not_preparing', async () => {
    const table = await startedWithSpare();
    const res = await assign(table, table.players.FACTORY.id, 'RETAILER');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('game.not_preparing');
  });

  it('資格がすでに失効している参加者（外された旧担当者・手動で失効させた参加者）は 409 game.credential_already_revoked', async () => {
    const table = await startedWithSpare();
    await assign(table, table.spare.id, 'RETAILER');
    const replaced = await assign(table, table.players.RETAILER.id, 'FACTORY');
    expect(replaced.statusCode).toBe(409);
    expect(replaced.json().code).toBe('game.credential_already_revoked');

    const other = await startedWithSpare();
    const revoke = await server.inject({
      method: 'POST',
      url: `/api/v1/games/${other.gameId}/credentials/revoke`,
      payload: { subject: { kind: 'PARTICIPANT', id: other.spare.id } },
      headers: {
        origin: ORIGIN,
        cookie: `bg_session=${other.facilitator}`,
        'idempotency-key': randomUUID(),
      },
    });
    expect(revoke.statusCode).toBe(200);
    const res = await assign(other, other.spare.id, 'RETAILER');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('game.credential_already_revoked');
  });

  it('存在しない参加者は 404 game.participant_not_found。進行役でなければ 403', async () => {
    const table = await startedWithSpare();
    const missing = await assign(table, randomUUID(), 'RETAILER');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('game.participant_not_found');
    const player = await assign(
      table,
      table.spare.id,
      'RETAILER',
      table.players.FACTORY.token,
    );
    expect(player.statusCode).toBe(403);
    expect(player.json().code).toBe('app.unauthorized');
  });

  it('終了後は 409 session.already_ended', async () => {
    const table = await startedWithSpare(1);
    for (const role of ROLES) {
      await app.saveDecision({
        token: table.players[role].token,
        gameId: table.gameId,
        role,
        quantity: 4,
        expectedVersion: 0,
      });
    }
    const { sessionVersion } = await app.console({
      token: table.facilitator,
      gameId: table.gameId,
    });
    await app.commitWeek({
      token: table.facilitator,
      gameId: table.gameId,
      week: 1,
      version: sessionVersion,
      idempotencyKey: 'week-1',
    });
    const res = await assign(table, table.spare.id, 'RETAILER');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('session.already_ended');
  });

  it('停止中も受け付ける', async () => {
    const table = await startedWithSpare();
    await app.pauseSession({ token: table.facilitator, gameId: table.gameId });
    const res = await assign(table, table.spare.id, 'WHOLESALER');
    expect(res.statusCode).toBe(200);
  });
});
