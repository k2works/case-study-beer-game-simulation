import { describe, expect, it } from 'vitest';
import { ROLES } from '../../../src/server/domain/types.js';
import { bearer, buildTestApp, json } from '../../u1/support/app.js';

async function startedOverHttp() {
  const test = await buildTestApp();
  const { app } = test;
  const created = json(
    await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { name: '検査', weekCount: 3 },
    }),
  );
  const fac = bearer(created.codes.facilitatorCode);
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  for (const role of ROLES) {
    const joined = json(
      await app.inject({
        method: 'POST',
        url: '/api/games/join',
        payload: { joinCode: created.codes.joinCode, displayName: role },
      }),
    );
    ids[role] = joined.participantId;
    tokens[role] = joined.token;
    await app.inject({
      method: 'PUT',
      url: `/api/games/${created.gameId}/assignments/${joined.participantId}`,
      headers: fac,
      payload: { role },
    });
  }
  await app.inject({ method: 'POST', url: `/api/games/${created.gameId}/start`, headers: fac });
  return { ...test, created, fac, ids, tokens };
}

describe('NFR6.6、NFR6.7 ログに資格情報が出ない', () => {
  it('入れ替えを成功させ、旧 token での拒否も起こした後の構造化ログに、token・進行役用コード・参加コードの文字列がない', async () => {
    const { app, logs, created, fac, ids, tokens } = await startedOverHttp();
    const replaced = json(
      await app.inject({
        method: 'POST',
        url: `/api/games/${created.gameId}/roles/retailer/replacement`,
        headers: fac,
        payload: { participantId: ids.retailer, displayName: '新人' },
      }),
    );
    await app.inject({
      method: 'GET',
      url: `/api/games/${created.gameId}/state`,
      headers: bearer(tokens.retailer!),
    });
    await app.inject({
      method: 'POST',
      url: `/api/games/${created.gameId}/pause`,
      headers: bearer(replaced.token),
    });
    const text = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [
      replaced.token,
      tokens.retailer!,
      created.codes.facilitatorCode,
      created.codes.joinCode,
      created.codes.observerCode,
    ]) {
      expect(text).not.toContain(secret);
    }
    // 拒否は種類と操作だけを記録する（許可リスト）
    const denied = logs.filter((line) => line.result === 'forbidden');
    expect(denied.length).toBeGreaterThanOrEqual(2);
    for (const line of denied) {
      expect(Object.keys(line).sort()).toEqual(
        expect.arrayContaining(['operation', 'reqId', 'result', 'status']),
      );
      expect(Object.keys(line)).not.toContain('body');
      expect(Object.keys(line)).not.toContain('authorization');
    }
  });
});

describe('NFR6.1 終了の理由を外部から指定できない', () => {
  it('準備中のゲームに reason=autoEnd を付けて終了を要求しても、拒否される（autoEnd は内部の経路だけ）', async () => {
    const { app } = await buildTestApp();
    const created = json(
      await app.inject({
        method: 'POST',
        url: '/api/games',
        payload: { name: '準備中', weekCount: 3 },
      }),
    );
    for (const reason of ['autoEnd', 'finalWeek', 'facilitator']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/games/${created.gameId}/end`,
        headers: { ...bearer(created.codes.facilitatorCode), 'content-type': 'application/json' },
        payload: { reason },
      });
      expect(response.statusCode).toBe(409);
    }
  });

  it('autoEnd・finalWeek の入口は存在しない（HTTP の経路にない）', async () => {
    const { app } = await buildTestApp();
    const created = json(
      await app.inject({
        method: 'POST',
        url: '/api/games',
        payload: { name: '経路', weekCount: 3 },
      }),
    );
    for (const url of ['auto-end', 'autoEnd', 'final-week', 'end/autoEnd']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/games/${created.gameId}/${url}`,
        headers: bearer(created.codes.facilitatorCode),
      });
      expect(response.statusCode).toBe(404);
    }
  });
});

describe('NFR6.2 入れ替えの応答', () => {
  it('Idempotency-Key を使わずに通り、応答は no-store で、token は応答の本文だけにある', async () => {
    const { app, created, fac, ids } = await startedOverHttp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/games/${created.gameId}/roles/factory/replacement`,
      headers: fac,
      payload: { participantId: ids.factory, displayName: '新人' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(response.headers)).not.toContain(json(response).token);
    // 履歴の取得にも token は含まれない
    const history = await app.inject({
      method: 'GET',
      url: `/api/games/${created.gameId}/history`,
      headers: fac,
    });
    expect(history.body).not.toContain(json(response).token);
  });

  it('役割が不正な入れ替えは 422、参加者の token は 403', async () => {
    const { app, created, fac, ids, tokens } = await startedOverHttp();
    const bad = await app.inject({
      method: 'POST',
      url: `/api/games/${created.gameId}/roles/brewer/replacement`,
      headers: fac,
      payload: { participantId: ids.factory, displayName: '新人' },
    });
    expect(bad.statusCode).toBe(422);
    const denied = await app.inject({
      method: 'POST',
      url: `/api/games/${created.gameId}/roles/factory/replacement`,
      headers: bearer(tokens.factory!),
      payload: { participantId: ids.factory, displayName: '新人' },
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('BR10.1 契約: PUT assignments は進行中に常に 409 state', () => {
  it('進行中の割当ての要求は、入れ替えの案内つきで 409', async () => {
    const { app, created, fac, ids } = await startedOverHttp();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/games/${created.gameId}/assignments/${ids.retailer}`,
      headers: fac,
      payload: { role: 'factory' },
    });
    expect(response.statusCode).toBe(409);
    expect(json(response).kind).toBe('state');
    expect(json(response).hint).toContain('replacement');
  });
});
