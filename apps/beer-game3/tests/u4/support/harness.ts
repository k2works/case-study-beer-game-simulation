import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadKeyRing } from '../../../src/server/access/keys.js';
import type { AccessPolicy } from '../../../src/server/access/policy.js';
import type { RandomSource } from '../../../src/server/clock.js';
import { cryptoRandom } from '../../../src/server/clock.js';
import { ROLES, type Role } from '../../../src/server/domain/types.js';
import { createApp } from '../../../src/server/http/app.js';
import { MemoryStore } from '../../../src/server/session/memory-store.js';
import type { Store } from '../../../src/server/session/store.js';
import { bearer, json, type Json } from '../../u1/support/app.js';
import { FixedClock, SequenceRandom, TEST_ENV, newKey } from '../../u1/support/world.js';

export { bearer, json, type Json };

export interface U4App {
  app: FastifyInstance;
  store: Store;
  clock: FixedClock;
  logs: Array<Record<string, unknown>>;
}

export interface U4Options {
  store?: Store;
  clock?: FixedClock;
  random?: RandomSource;
  trustedProxyHops?: number;
  policy?: Partial<AccessPolicy>;
  enforceHttps?: boolean;
}

/** U4 の試験用の入口。時計・保存・乱数を差し替えられる（2 つのアプリケーションが同じ保存を共有する試験にも使う）。 */
export async function buildU4App(options: U4Options = {}): Promise<U4App> {
  const logs: Array<Record<string, unknown>> = [];
  const clock = options.clock ?? new FixedClock();
  const store = options.store ?? new MemoryStore({ lockTimeoutMs: 3000 });
  const app = await createApp({
    store,
    keyRing: loadKeyRing(TEST_ENV),
    clock,
    random: options.random ?? new SequenceRandom(),
    log: (line) => logs.push(line),
    hsts: false,
    enforceHttps: options.enforceHttps ?? false,
    ...(options.trustedProxyHops !== undefined
      ? { trustedProxyHops: options.trustedProxyHops }
      : {}),
    ...(options.policy ? { policy: options.policy } : {}),
  });
  return { app, store, clock, logs };
}

/** 2 つ目のアプリケーション用の乱数（1 つ目と識別子が重ならない）。 */
export const secondRandom = (): RandomSource => cryptoRandom;

export interface Booted {
  gameId: string;
  joinCode: string;
  facilitatorCode: string;
  observerCode: string;
  facilitator: Record<string, string>;
  /** 役割ごとの参加者 */
  players: Record<Role, { participantId: string; token: string }>;
}

const NAMES: Record<Role, string> = {
  factory: '工場',
  wholesaler1: '一次卸',
  wholesaler2: '二次卸',
  retailer: '小売店',
};

async function expectStatus(response: LightMyRequestResponse, status: number, label: string) {
  if (response.statusCode !== status) {
    throw new Error(`${label}に失敗: ${response.statusCode} ${response.body}`);
  }
  return response;
}

/** HTTP の入口だけで、ゲームの作成 → 4 人の参加と割当てを行い、必要なら開始する。 */
export async function bootGame(
  app: FastifyInstance,
  options: { start?: boolean; weekCount?: number; demandSeries?: number[] } = {},
): Promise<Booted> {
  const created = json(
    await expectStatus(
      await app.inject({
        method: 'POST',
        url: '/api/games',
        payload: {
          name: 'U4 の試験',
          weekCount: options.weekCount ?? 12,
          demandSeries: options.demandSeries ?? [8, 4, 4, 6, 5, 7, 3, 4, 9, 2, 5, 6],
        },
      }),
      201,
      '作成',
    ),
  );
  const facilitator = bearer(created.codes.facilitatorCode);
  const players = {} as Booted['players'];
  for (const role of ROLES) {
    const joined = json(
      await expectStatus(
        await app.inject({
          method: 'POST',
          url: '/api/games/join',
          payload: { joinCode: created.codes.joinCode, displayName: NAMES[role] },
        }),
        201,
        '参加',
      ),
    );
    await expectStatus(
      await app.inject({
        method: 'PUT',
        url: `/api/games/${created.gameId}/assignments/${joined.participantId}`,
        headers: facilitator,
        payload: { role },
      }),
      200,
      '割当て',
    );
    players[role] = { participantId: joined.participantId, token: joined.token };
  }
  if (options.start !== false) {
    await expectStatus(
      await app.inject({
        method: 'POST',
        url: `/api/games/${created.gameId}/start`,
        headers: facilitator,
      }),
      200,
      '開始',
    );
  }
  return {
    gameId: created.gameId,
    joinCode: created.codes.joinCode,
    facilitatorCode: created.codes.facilitatorCode,
    observerCode: created.codes.observerCode,
    facilitator,
    players,
  };
}

/** 4 役割が入力し、進行役が週を確定する。 */
export async function playWeek(
  app: FastifyInstance,
  game: Booted,
  week: number,
  quantities: Partial<Record<Role, number>> = {},
  confirmKey: string = newKey(`u4-confirm-w${week}`),
): Promise<Json> {
  for (const role of ROLES) {
    await expectStatus(
      await app.inject({
        method: 'PUT',
        url: `/api/games/${game.gameId}/weeks/${week}/decisions/${role}`,
        headers: {
          ...bearer(game.players[role].token),
          'idempotency-key': newKey(`u4-in-${role}-w${week}`),
        },
        payload: { quantity: quantities[role] ?? 4 },
      }),
      200,
      `第 ${week} 週の入力`,
    );
  }
  const confirmed = await expectStatus(
    await app.inject({
      method: 'POST',
      url: `/api/games/${game.gameId}/weeks/${week}/confirm`,
      headers: { ...game.facilitator, 'idempotency-key': confirmKey },
    }),
    200,
    `第 ${week} 週の確定`,
  );
  return json(confirmed);
}

/** 無効な参加コードで参加を試みる（接続元を指定できる）。 */
export function joinWithBadCode(
  app: FastifyInstance,
  remoteAddress = '203.0.113.10',
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/games/join',
    remoteAddress,
    headers,
    payload: { joinCode: 'WRONGCODE2', displayName: '試す人' },
  });
}

export const GET = (
  app: FastifyInstance,
  url: string,
  credential?: string,
  remoteAddress?: string,
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'GET',
    url,
    ...(credential ? { headers: bearer(credential) } : {}),
    ...(remoteAddress ? { remoteAddress } : {}),
  });
