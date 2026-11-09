import { buildApp } from '../src/api/app.js';
import { GameService, type Actor } from '../src/application/game-service.js';
import { LearningViewService } from '../src/learning/learning-view.js';
import { LatencyHistogram } from './u5-harness.js';

const GAME_COUNT = 15;
const CLIENTS_PER_GAME = 5;
const BURSTS = 5;
const ROLES = ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'] as const;

process.env.API_RATE_LIMIT_PER_MINUTE = '6000';
const service = new GameService();
const app = await buildApp(service, new LearningViewService());
const controllers: AbortController[] = [];
try {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const base = new URL(address).origin;
  process.env.ALLOWED_ORIGIN = base;
  const clients: { gameId: string; sessionId: string; actor: Actor; cookie: string }[] = [];
  for (let gameIndex = 0; gameIndex < GAME_COUNT; gameIndex++) {
    const game = service.createGame({ finalWeek: 1, demand: [4] }, `load-game-${gameIndex}`);
    const facilitator: Actor = { id: game.gameId, gameId: game.gameId, kind: 'FACILITATOR' };
    clients.push({
      gameId: game.gameId,
      sessionId: game.sessionId,
      actor: facilitator,
      cookie: `bg_session=${service.issueBrowserSession(facilitator)}`,
    });
    for (let roleIndex = 0; roleIndex < ROLES.length; roleIndex++) {
      const joined = service.joinGame(
        game.gameId,
        `P${roleIndex}`,
        `load-join-${gameIndex}-${roleIndex}`,
      );
      service.assignRole(facilitator, joined.participantId, ROLES[roleIndex]);
      const actor = service.actorForParticipant(game.gameId, joined.participantId);
      clients.push({
        gameId: game.gameId,
        sessionId: game.sessionId,
        actor,
        cookie: `bg_session=${service.issueBrowserSession(actor)}`,
      });
    }
  }
  if (clients.length !== GAME_COUNT * CLIENTS_PER_GAME)
    throw new Error('Client fixture count is incorrect');

  const sseOpen = new LatencyHistogram();
  const streams = await Promise.all(
    clients.map(async (client) => {
      const controller = new AbortController();
      controllers.push(controller);
      const started = performance.now();
      const response = await fetch(`${base}/api/v1/games/${client.gameId}/events`, {
        headers: { Cookie: client.cookie },
        signal: controller.signal,
      });
      sseOpen.record(started, performance.now());
      if (response.status !== 200 || !response.body)
        throw new Error(`SSE open failed: ${response.status}`);
      return response.body.getReader();
    }),
  );

  const snapshotLatency = new LatencyHistogram();
  let failures = 0;
  for (let burst = 0; burst < BURSTS; burst++) {
    await Promise.all(
      clients.map(async (client) => {
        const path =
          client.actor.kind === 'FACILITATOR'
            ? `/api/v1/games/${client.gameId}/lobby`
            : `/api/v1/sessions/${client.sessionId}/state`;
        const started = performance.now();
        try {
          const response = await fetch(`${base}${path}`, { headers: { Cookie: client.cookie } });
          snapshotLatency.record(started, performance.now());
          if (response.status !== 200) failures += 1;
          await response.arrayBuffer();
        } catch {
          failures += 1;
        }
      }),
    );
    if (burst < BURSTS - 1) await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  process.stdout.write(
    JSON.stringify({
      games: GAME_COUNT,
      sseConnections: streams.length,
      pollingClients: clients.length,
      pollingSamples: snapshotLatency.count,
      pollingFailures: failures,
      sseOpenP95Ms: sseOpen.p95(),
      snapshotP95Ms: snapshotLatency.p95(),
      snapshotMaxMs: snapshotLatency.max(),
      note: 'Single-process local transport diagnostic; this does not measure browser commit-to-render or multi-task correctness.',
    }) + '\n',
  );
} finally {
  for (const controller of controllers) controller.abort();
  await app.close();
}
