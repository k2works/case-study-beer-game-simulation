import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Application } from '../../src/application/index.js';
import { bootApp, ORIGIN } from './boot.js';
import { preparedTable, startedTable } from './fixtures.js';
import { expectConforms } from './spec.js';

// 復帰・観察者・資格の失効と再発行（recoverParticipation・inviteObserver・revokeObserverInvitation・joinAsObserver・
// revokeCredential・reissueCredential）が、共有の契約に適合し、契約の規則を守る

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
}
const post = (url: string, payload: unknown, sent: Sent = {}) =>
  server.inject({
    method: 'POST',
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: {
      origin: ORIGIN,
      ...(sent.key === null
        ? {}
        : { 'idempotency-key': sent.key ?? randomUUID() }),
      ...(sent.cookie ? { cookie: sent.cookie } : {}),
    },
  });
const session = (token: string) => `bg_session=${token}`;
const get = (url: string, token: string) =>
  server.inject({ method: 'GET', url, headers: { cookie: session(token) } });
const cookiesOf = (res: { cookies: Array<Record<string, unknown>> }) =>
  Object.fromEntries(res.cookies.map((c) => [c.name as string, c]));

describe('recoverParticipation（POST /participations/recover）', () => {
  it('本文の復帰コードで、新しいブラウザセッションを発行して復帰する（進行役）', async () => {
    await boot();
    const created = await app.createGame({ weeks: 2, demand: [4, 4] });
    const res = await post('/api/v1/participations/recover', {
      gameId: created.gameId,
      recoveryCode: created.recoveryCode,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectConforms('RecoverResponse', body);
    expect(body).toMatchObject({ gameId: created.gameId, kind: 'FACILITATOR' });
    expect(body.role).toBeUndefined();
    const cookies = cookiesOf(res);
    // 新しいセッションは、元のセッションとは別の値
    expect(cookies.bg_session!.value).not.toBe(created.facilitatorToken);
    const state = await get(
      `/api/v1/games/${created.gameId}/state`,
      cookies.bg_session!.value as string,
    );
    expect(state.statusCode).toBe(200);
  });

  it('Cookie の復帰資格（bg_recovery）でも復帰できる。参加者は、担当の役割を返す', async () => {
    await boot();
    // 参加者の復帰コードは、参加の応答（HTTP の Cookie）で得る
    const created = await app.createGame({ weeks: 2, demand: [4, 4] });
    const join = await post('/api/v1/participations/join', {
      joinCode: created.joinCode,
      displayName: '田中',
    });
    const recoveryCookie = cookiesOf(join).bg_recovery!.value as string;
    await app.assignRole({
      token: created.facilitatorToken,
      gameId: created.gameId,
      participantId: (
        await get(
          `/api/v1/games/${created.gameId}/state`,
          cookiesOf(join).bg_session!.value as string,
        )
      ).json().participantId,
      role: 'WHOLESALER',
    });
    const res = await post(
      '/api/v1/participations/recover',
      { gameId: created.gameId },
      { cookie: `bg_recovery=${recoveryCookie}` },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectConforms('RecoverResponse', body);
    expect(body).toMatchObject({
      kind: 'PARTICIPANT',
      gameId: created.gameId,
      role: 'WHOLESALER',
    });
  });

  it('不明・失効・別のゲームの復帰資格は、区別せず同じ 403（app.unauthorized）', async () => {
    await boot();
    const a = await app.createGame({ weeks: 2, demand: [4, 4] });
    const b = await app.createGame({ weeks: 2, demand: [4, 4] });
    const cases = [
      { gameId: a.gameId, recoveryCode: 'unknown' },
      { gameId: a.gameId, recoveryCode: b.recoveryCode }, // 別のゲームの復帰コード
      { gameId: randomUUID(), recoveryCode: a.recoveryCode }, // ゲームの ID が違う
      { gameId: a.gameId }, // 復帰コードが無く、Cookie も無い
    ];
    for (const payload of cases) {
      const res = await post('/api/v1/participations/recover', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(403);
      expect(res.json().code).toBe('app.unauthorized');
    }
    const bad = await post('/api/v1/participations/recover', {
      gameId: 'not-a-uuid',
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0].field).toBe('gameId');
  });

  it('同じキーの再送は、同じ応答（同じセッション）。試行が多すぎると 429', async () => {
    await boot({ rateLimit: 3 });
    const a = await app.createGame({ weeks: 2, demand: [4, 4] });
    const key = randomUUID();
    const request = { gameId: a.gameId, recoveryCode: a.recoveryCode };
    const first = await post('/api/v1/participations/recover', request, {
      key,
    });
    const second = await post('/api/v1/participations/recover', request, {
      key,
    });
    expect(second.json()).toEqual(first.json());
    expect(cookiesOf(second).bg_session!.value).toBe(
      cookiesOf(first).bg_session!.value,
    );
    await post('/api/v1/participations/recover', request);
    const limited = await post('/api/v1/participations/recover', request);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('app.rate_limited');
  });
});

describe('観察者（inviteObserver・revokeObserverInvitation・joinAsObserver）', () => {
  const invite = (gameId: string, token: string, key?: string) =>
    post(
      `/api/v1/games/${gameId}/observer-invitations`,
      {},
      {
        cookie: session(token),
        ...(key ? { key } : {}),
      },
    );

  it('進行役が招待を発行する。招待コードは、この応答で一度だけ示す。ロビーに、招待が出る（コードは出ない）', async () => {
    await boot();
    const created = await app.createGame({ weeks: 2, demand: [4, 4] });
    const res = await invite(created.gameId, created.facilitatorToken);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectConforms('InviteObserverResponse', body);
    const lobby = (
      await get(
        `/api/v1/games/${created.gameId}/lobby`,
        created.facilitatorToken,
      )
    ).json();
    expectConforms('Lobby', lobby);
    expect(lobby.invitations).toHaveLength(1);
    expect(lobby.invitations[0]).toMatchObject({
      invitationId: body.invitationId,
      revoked: false,
    });
    expect(JSON.stringify(lobby)).not.toContain(body.invitationCode);
  });

  it('招待を発行できるのは、進行役だけ。同じキーの再送は、同じ招待コード', async () => {
    await boot();
    const t = await preparedTable(app);
    const denied = await invite(t.gameId, t.players.RETAILER.token);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('app.unauthorized');
    const key = randomUUID();
    const a = await invite(t.gameId, t.facilitator, key);
    const b = await invite(t.gameId, t.facilitator, key);
    expect(b.json()).toEqual(a.json());
    const lobby = (
      await get(`/api/v1/games/${t.gameId}/lobby`, t.facilitator)
    ).json();
    expect(lobby.invitations).toHaveLength(1);
  });

  it('招待コードで、観察者として参加する。ブラウザセッションだけを発行し、復帰資格は発行しない', async () => {
    await boot();
    const t = await startedTable(app);
    const code = (await invite(t.gameId, t.facilitator)).json().invitationCode;
    const res = await post('/api/v1/participations/observe', {
      invitationCode: code,
      displayName: '見学者',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectConforms('JoinObserverResponse', body);
    expect(body).toMatchObject({ gameId: t.gameId, kind: 'OBSERVER' });
    const cookies = cookiesOf(res);
    expect(cookies.bg_session).toBeTruthy();
    expect(cookies.bg_recovery).toBeUndefined();
    // 観察者の資格で、観察できる。ロビーとセッションの状態は開けない
    const token = cookies.bg_session!.value as string;
    expect(
      (await get(`/api/v1/games/${t.gameId}/observation`, token)).statusCode,
    ).toBe(200);
    expect(
      (await get(`/api/v1/games/${t.gameId}/lobby`, token)).statusCode,
    ).toBe(403);
    const lobby = (
      await get(`/api/v1/games/${t.gameId}/lobby`, t.facilitator)
    ).json();
    expect(lobby.observers).toHaveLength(1);
    expect(lobby.observers[0].displayName).toBe('見学者');
  });

  it('不明・失効・形式不正の招待コードは、区別せず 403（game.invitation_invalid）', async () => {
    await boot();
    const created = await app.createGame({ weeks: 2, demand: [4, 4] });
    const issued = (
      await invite(created.gameId, created.facilitatorToken)
    ).json();
    await post(
      `/api/v1/games/${created.gameId}/observer-invitations/${issued.invitationId}/revoke`,
      undefined,
      { cookie: session(created.facilitatorToken) },
    );
    for (const invitationCode of ['unknown', '', issued.invitationCode]) {
      const res = await post('/api/v1/participations/observe', {
        invitationCode,
        displayName: '見学者',
      });
      expect(res.statusCode, invitationCode).toBe(403);
      expect(res.json().code).toBe('game.invitation_invalid');
    }
  });

  it('招待の失効: 参加済みの観察者は、観察を続けられる。もう一度の失効は 409、無い招待は 404', async () => {
    await boot();
    const t = await startedTable(app);
    const issued = (await invite(t.gameId, t.facilitator)).json();
    const joined = await post('/api/v1/participations/observe', {
      invitationCode: issued.invitationCode,
      displayName: '見学者',
    });
    const observer = cookiesOf(joined).bg_session!.value as string;
    const revokeUrl = `/api/v1/games/${t.gameId}/observer-invitations/${issued.invitationId}/revoke`;
    const revoked = await post(revokeUrl, undefined, {
      cookie: session(t.facilitator),
    });
    expect(revoked.statusCode).toBe(200);
    expectConforms('CommandResponse', revoked.json());
    expect(
      (await get(`/api/v1/games/${t.gameId}/observation`, observer)).statusCode,
    ).toBe(200);
    const again = await post(revokeUrl, undefined, {
      cookie: session(t.facilitator),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('game.credential_already_revoked');
    const missing = await post(
      `/api/v1/games/${t.gameId}/observer-invitations/${randomUUID()}/revoke`,
      undefined,
      { cookie: session(t.facilitator) },
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('game.invitation_not_found');
    const lobby = (
      await get(`/api/v1/games/${t.gameId}/lobby`, t.facilitator)
    ).json();
    expect(lobby.invitations[0].revoked).toBe(true);
  });

  it('失効は、進行役だけ。参加者は 403', async () => {
    await boot();
    const t = await startedTable(app);
    const issued = (await invite(t.gameId, t.facilitator)).json();
    const res = await post(
      `/api/v1/games/${t.gameId}/observer-invitations/${issued.invitationId}/revoke`,
      undefined,
      { cookie: session(t.players.FACTORY.token) },
    );
    expect(res.statusCode).toBe(403);
  });
});

describe('資格の失効と再発行（revokeCredential・reissueCredential）', () => {
  const subject = (participantId: string) => ({
    subject: { kind: 'PARTICIPANT', id: participantId },
  });
  const revoke = (
    gameId: string,
    participantId: string,
    token: string,
    key?: string,
  ) =>
    post(`/api/v1/games/${gameId}/credentials/revoke`, subject(participantId), {
      cookie: session(token),
      ...(key ? { key } : {}),
    });
  const reissue = (
    gameId: string,
    participantId: string,
    token: string,
    key?: string,
  ) =>
    post(
      `/api/v1/games/${gameId}/credentials/reissue`,
      subject(participantId),
      {
        cookie: session(token),
        ...(key ? { key } : {}),
      },
    );

  it('失効させると、その参加者のブラウザセッションと復帰コードが、すべて使えない。ほかの参加者は影響しない', async () => {
    await boot();
    const t = await startedTable(app);
    const target = t.players.RETAILER;
    const res = await revoke(t.gameId, target.participantId, t.facilitator);
    expect(res.statusCode).toBe(200);
    expectConforms('CommandResponse', res.json());
    const denied = await get(`/api/v1/games/${t.gameId}/state`, target.token);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('app.unauthorized');
    expect(
      (await get(`/api/v1/games/${t.gameId}/state`, t.players.FACTORY.token))
        .statusCode,
    ).toBe(200);
  });

  it('もう一度の失効は 409（game.credential_already_revoked）。存在しない参加者は 404', async () => {
    await boot();
    const t = await startedTable(app);
    const id = t.players.RETAILER.participantId;
    await revoke(t.gameId, id, t.facilitator);
    const again = await revoke(t.gameId, id, t.facilitator);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('game.credential_already_revoked');
    const unknown = await revoke(t.gameId, randomUUID(), t.facilitator);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('game.participant_not_found');
  });

  it('再発行: 新しい復帰コードを一度だけ示し、そのコードで復帰できる。有効期限を返す', async () => {
    await boot();
    const t = await startedTable(app);
    const target = t.players.RETAILER;
    await revoke(t.gameId, target.participantId, t.facilitator);
    const res = await reissue(t.gameId, target.participantId, t.facilitator);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectConforms('ReissueResponse', body);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    const back = await post('/api/v1/participations/recover', {
      gameId: t.gameId,
      recoveryCode: body.recoveryCode,
    });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({
      kind: 'PARTICIPANT',
      role: 'RETAILER',
    });
    // 失効した古いセッションは、使えないまま
    expect(
      (await get(`/api/v1/games/${t.gameId}/state`, target.token)).statusCode,
    ).toBe(403);
  });

  it('失効していない資格の再発行は 409（game.credential_not_revoked）。再発行したあとの再発行も 409', async () => {
    await boot();
    const t = await startedTable(app);
    const id = t.players.RETAILER.participantId;
    const notRevoked = await reissue(t.gameId, id, t.facilitator);
    expect(notRevoked.statusCode).toBe(409);
    expect(notRevoked.json().code).toBe('game.credential_not_revoked');
    await revoke(t.gameId, id, t.facilitator);
    expect((await reissue(t.gameId, id, t.facilitator)).statusCode).toBe(200);
    const twice = await reissue(t.gameId, id, t.facilitator);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe('game.credential_not_revoked');
  });

  it('進行役だけ。参加者・無資格は 403。subject の形が違えば 422', async () => {
    await boot();
    const t = await startedTable(app);
    const id = t.players.RETAILER.participantId;
    for (const token of [t.players.FACTORY.token, 'invalid']) {
      expect((await revoke(t.gameId, id, token)).statusCode).toBe(403);
      expect((await reissue(t.gameId, id, token)).statusCode).toBe(403);
    }
    const bad = await post(
      `/api/v1/games/${t.gameId}/credentials/revoke`,
      { subject: { kind: 'FACILITATOR', id } },
      { cookie: session(t.facilitator) },
    );
    expect(bad.statusCode).toBe(422);
  });

  it('同じキーの再送は、保存した応答（再発行の復帰コードも同じ）。失効した資格での再送は、保存した応答を返さない', async () => {
    await boot();
    const t = await startedTable(app);
    const id = t.players.RETAILER.participantId;
    await revoke(t.gameId, id, t.facilitator);
    const key = randomUUID();
    const a = await reissue(t.gameId, id, t.facilitator, key);
    const b = await reissue(t.gameId, id, t.facilitator, key);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    // 資格が失効（無効）なら、以前に成功したキーを再送しても、保存した応答は返らない（ADR-004）
    const denied = await reissue(t.gameId, id, 'invalid', key);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('app.unauthorized');
    expect(denied.json().recoveryCode).toBeUndefined();
  });
});
