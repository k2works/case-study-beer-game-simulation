import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { GameService } from '../../src/application/game-service.js';
import { LearningViewService } from '../../src/learning/learning-view.js';

describe('Given an actual game feeding the learning provider', () => {
  const previousOrigin = process.env.ALLOWED_ORIGIN;
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    if (previousOrigin === undefined) delete process.env.ALLOWED_ORIGIN;
    else process.env.ALLOWED_ORIGIN = previousOrigin;
  });

  it('suppresses small-group totals in observation without placing values in the response', async () => {
    process.env.ALLOWED_ORIGIN = 'https://beer-game.example.test';
    const service = new GameService();
    const app = await buildApp(service, new LearningViewService());
    apps.push(app);
    const game = service.createGame({ finalWeek: 1, demand: [4] }, 'learning-create');
    const cookie = `bg_session=${service.issueBrowserSession({ id: game.gameId, gameId: game.gameId, kind: 'FACILITATOR' })}`;
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${game.gameId}/observation`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().safeTeamTotals).toBeUndefined();
    expect(response.json().suppressionReasons).toContain('INSUFFICIENT_CONTRIBUTORS');
    expect(response.body).not.toContain('futureDemand');
    const premature = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${game.gameId}/exports`,
      headers: {
        cookie,
        origin: process.env.ALLOWED_ORIGIN,
        'idempotency-key': 'premature-export',
      },
    });
    expect(premature.statusCode).toBe(409);
    expect(premature.json().title).toBe('GAME_NOT_ENDED');
  });

  it('returns an ended weekly series and complete CSV / JSON downloads', async () => {
    process.env.ALLOWED_ORIGIN = 'https://beer-game.example.test';
    const service = new GameService();
    const app = await buildApp(service, new LearningViewService());
    apps.push(app);
    const game = service.createGame({ finalWeek: 1, demand: [4] }, 'learning-create');
    const actor = { id: game.gameId, gameId: game.gameId, kind: 'FACILITATOR' as const };
    const cookie = `bg_session=${service.issueBrowserSession(actor)}`;
    for (const [index, role] of (
      ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'] as const
    ).entries()) {
      const joined = service.joinGame(game.gameId, role, `learning-join-${index}`);
      service.assignRole(actor, joined.participantId, role);
    }
    service.startSession(actor);
    for (const role of ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'] as const)
      service.submitProxyDecision(actor, role, 4, 0, `learning-proxy-${role}`);
    service.commitWeek(actor, 2, 'learning-commit', 1);
    const review = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${game.gameId}/review`,
      headers: { cookie },
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().weeklySeries).toHaveLength(1);
    expect(review.json().weeklySeries[0]).toEqual(
      expect.objectContaining({
        demand: expect.any(Number),
        shipments: expect.any(Number),
        costMinor: expect.any(Number),
      }),
    );
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${game.gameId}/exports`,
      headers: { cookie, origin: process.env.ALLOWED_ORIGIN, 'idempotency-key': 'learning-export' },
    });
    expect(created.statusCode).toBe(202);
    const csv = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${game.gameId}/exports/${created.json().exportId}/download?format=csv`,
      headers: { cookie },
    });
    const json = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${game.gameId}/exports/${created.json().exportId}/download?format=json`,
      headers: { cookie },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-disposition']).toContain('attachment');
    expect(csv.body).toContain('week,inventory,backlog,orders');
    expect(JSON.parse(json.body).weeklySeries).toHaveLength(1);
  });
});
