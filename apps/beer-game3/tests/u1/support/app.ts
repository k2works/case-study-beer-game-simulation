import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadKeyRing } from '../../../src/server/access/keys.js';
import { createApp } from '../../../src/server/http/app.js';
import { MemoryStore } from '../../../src/server/session/memory-store.js';
import type { Store } from '../../../src/server/session/store.js';
import { FixedClock, SequenceRandom, TEST_ENV, newKey } from './world.js';

export interface TestApp {
  app: FastifyInstance;
  store: Store;
  /** 出力された構造化ログ（1 件 1 オブジェクト） */
  logs: Array<Record<string, unknown>>;
  clock: FixedClock;
}

export async function buildTestApp(
  options: {
    store?: Store;
    enforceHttps?: boolean;
    hsts?: boolean;
    webDist?: string;
  } = {},
): Promise<TestApp> {
  const logs: Array<Record<string, unknown>> = [];
  const clock = new FixedClock();
  const store = options.store ?? new MemoryStore({ lockTimeoutMs: 3000 });
  const app = await createApp({
    store,
    keyRing: loadKeyRing(TEST_ENV),
    clock,
    random: new SequenceRandom(),
    log: (line) => logs.push(line),
    hsts: options.hsts ?? false,
    enforceHttps: options.enforceHttps ?? false,
    ...(options.webDist ? { webDist: options.webDist } : {}),
  });
  return { app, store, logs, clock };
}

export const bearer = (credential: string): Record<string, string> => ({
  authorization: `Bearer ${credential}`,
});

/** 応答の JSON。試験では項目を気軽に辿れるよう、ゆるい型にする。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export const json = (response: LightMyRequestResponse): Json => response.json() as Json;

export interface ThinSliceResult {
  gameId: string;
  joinCode: string;
  facilitatorCode: string;
  tokens: Record<string, string>;
  finalState: Json;
  confirm: Json;
}

/**
 * 薄い一通りを HTTP の入口から通す: 作成 → 4 人の参加 → 割当て → 開始 → 4 役割の入力 → 確定 → 状態の表示。
 * メモリ上の保存と PostgreSQL の両方で使う。
 */
export async function runThinSlice(app: FastifyInstance): Promise<ThinSliceResult> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/games',
    payload: { name: '薄い一通り', weekCount: 3, demandSeries: [8, 4, 4] },
  });
  if (created.statusCode !== 201) {
    throw new Error(`作成に失敗: ${created.body}`);
  }
  const { gameId, codes } = json(created);
  const facilitator = bearer(codes.facilitatorCode);

  const roles = ['factory', 'wholesaler1', 'wholesaler2', 'retailer'] as const;
  const names = ['工場', '一次卸', '二次卸', '小売店'];
  const tokens: Record<string, string> = {};
  for (const [index, role] of roles.entries()) {
    const joined = await app.inject({
      method: 'POST',
      url: '/api/games/join',
      payload: { joinCode: codes.joinCode, displayName: names[index] },
    });
    if (joined.statusCode !== 201) {
      throw new Error(`参加に失敗: ${joined.body}`);
    }
    const { participantId, token } = json(joined);
    tokens[role] = token;
    const assigned = await app.inject({
      method: 'PUT',
      url: `/api/games/${gameId}/assignments/${participantId}`,
      headers: facilitator,
      payload: { role },
    });
    if (assigned.statusCode !== 200) {
      throw new Error(`割当てに失敗: ${assigned.body}`);
    }
  }
  const started = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/start`,
    headers: facilitator,
  });
  if (started.statusCode !== 200) {
    throw new Error(`開始に失敗: ${started.body}`);
  }
  for (const role of roles) {
    const input = await app.inject({
      method: 'PUT',
      url: `/api/games/${gameId}/weeks/1/decisions/${role}`,
      headers: { ...bearer(tokens[role]!), 'idempotency-key': newKey(`http-${role}`) },
      payload: { quantity: 4 },
    });
    if (input.statusCode !== 200) {
      throw new Error(`入力に失敗: ${input.body}`);
    }
  }
  const confirmed = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/weeks/1/confirm`,
    headers: { ...facilitator, 'idempotency-key': newKey('http-confirm') },
  });
  if (confirmed.statusCode !== 200) {
    throw new Error(`確定に失敗: ${confirmed.body}`);
  }
  const state = await app.inject({
    method: 'GET',
    url: `/api/games/${gameId}/state`,
    headers: bearer(tokens.retailer!),
  });
  return {
    gameId,
    joinCode: codes.joinCode,
    facilitatorCode: codes.facilitatorCode,
    tokens,
    finalState: json(state),
    confirm: json(confirmed),
  };
}
