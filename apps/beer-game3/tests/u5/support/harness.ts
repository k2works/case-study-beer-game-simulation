import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { ROLES, type Role } from '../../../src/server/domain/types.js';
import { FailureMemory } from '../../../src/server/retention/failure-memory.js';
import { RetentionJob } from '../../../src/server/retention/job.js';
import {
  DEFAULT_RETENTION_POLICY,
  type RetentionPolicy,
} from '../../../src/server/retention/policy.js';
import type { Store } from '../../../src/server/session/store.js';
import { createWorld, type StartedGame, type World } from '../../u1/support/world.js';
import {
  bearer,
  bootGame,
  buildU4App,
  GET,
  json,
  playWeek,
  type Booted,
  type Json,
  type U4App,
  type U4Options,
} from '../../u4/support/harness.js';

export { bearer, bootGame, buildU4App, GET, json, playWeek, ROLES };
export type { Booted, Json, Role, U4App, U4Options };

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 既知の入力系列（週ごと・役割ごとの発注数）。結果と出力の試験は、この系列から作る。 */
export const KNOWN_QUANTITIES: Array<Partial<Record<Role, number>>> = [
  { factory: 4, wholesaler1: 4, wholesaler2: 5, retailer: 6 },
  { factory: 5, wholesaler1: 6, wholesaler2: 8, retailer: 9 },
  { factory: 7, wholesaler1: 3, wholesaler2: 2, retailer: 4 },
  { factory: 2, wholesaler1: 9, wholesaler2: 5, retailer: 1 },
  { factory: 6, wholesaler1: 6, wholesaler2: 6, retailer: 6 },
];

export const quantitiesOf = (week: number): Partial<Record<Role, number>> =>
  KNOWN_QUANTITIES[(week - 1) % KNOWN_QUANTITIES.length] ?? {};

export const daysFromNow = (world: Pick<World, 'clock'>, days: number): Date =>
  new Date(world.clock.now().getTime() + days * DAY_MS);

/** サービスの層（HTTP を通さない）で、定期処理と一緒に動かす組み立て。 */
export interface Rig {
  world: World;
  store: Store;
  job: RetentionJob;
  failures: FailureMemory;
  logs: Array<Record<string, unknown>>;
  policy: RetentionPolicy;
}

export function buildRig(options: { store?: Store; policy?: Partial<RetentionPolicy> } = {}): Rig {
  const world = createWorld(options.store ? { store: options.store } : {});
  const policy: RetentionPolicy = { ...DEFAULT_RETENTION_POLICY, ...options.policy };
  const logs: Array<Record<string, unknown>> = [];
  const failures = new FailureMemory({ cooldownMs: policy.jobIntervalMinutes * 60_000 });
  const job = new RetentionJob({
    store: world.store,
    session: world.session,
    clock: world.clock,
    policy,
    log: (line) => logs.push(line),
    failures,
  });
  return { world, store: world.store, job, failures, logs, policy };
}

/** 作成 → 参加 → 開始 → N 週を確定（最終週まで確定すると finalWeek で終了する）。 */
export async function playedGame(
  world: World,
  options: { weekCount?: number; confirmWeeks?: number; demandSeries?: number[] } = {},
): Promise<StartedGame> {
  const weekCount = options.weekCount ?? 3;
  const game = await world.startedGame({
    weekCount,
    demandSeries:
      options.demandSeries ?? Array.from({ length: weekCount }, (_, i) => [8, 4, 6, 5, 7][i % 5]!),
  });
  const confirmWeeks = options.confirmWeeks ?? weekCount;
  for (let week = 1; week <= confirmWeeks; week += 1) {
    await world.playWeek(game, week, quantitiesOf(week));
  }
  return game;
}

/** 最終週まで確定して終了したゲーム。 */
export const finishedGame = (world: World, weeks = 3): Promise<StartedGame> =>
  playedGame(world, { weekCount: weeks });

/** 一部の週を確定して、進行役が終了したゲーム。 */
export async function endedEarly(world: World, confirmWeeks = 2, weekCount = 6) {
  const game = await playedGame(world, { weekCount, confirmWeeks });
  await world.session.endGame(game.facilitator, game.gameId);
  return game;
}

/** HTTP の入口から、結果を取得する。 */
export const getResults = (
  app: FastifyInstance,
  gameId: string,
  credential?: string,
): Promise<LightMyRequestResponse> => GET(app, `/api/games/${gameId}/results`, credential);

/** HTTP の入口から、出力を取得する。 */
export const getExport = (
  app: FastifyInstance,
  gameId: string,
  credential: string | undefined,
  format?: string,
): Promise<LightMyRequestResponse> =>
  GET(
    app,
    `/api/games/${gameId}/export${format === undefined ? '' : `?format=${encodeURIComponent(format)}`}`,
    credential,
  );

/** HTTP の入口だけで、ゲームを最終週まで進めて終了させる。 */
export async function playToEnd(app: FastifyInstance, weeks = 3): Promise<Booted> {
  const game = await bootGame(app, {
    weekCount: weeks,
    demandSeries: Array.from({ length: weeks }, (_, i) => [8, 4, 6, 5, 7][i % 5]!),
  });
  for (let week = 1; week <= weeks; week += 1) {
    await playWeek(app, game, week, quantitiesOf(week));
  }
  return game;
}
