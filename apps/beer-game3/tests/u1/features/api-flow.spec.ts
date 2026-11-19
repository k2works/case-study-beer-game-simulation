import { describe, expect, it } from 'vitest';
import { bearer, buildTestApp, json, runThinSlice } from '../support/app.js';
import { newKey } from '../support/world.js';

describe('API の入口（C1）', () => {
  it('薄い一通り: 作成 → 4 人の参加 → 割当て → 開始 → 4 役割の入力 → 確定 → 状態の表示', async () => {
    const { app } = await buildTestApp();
    const result = await runThinSlice(app);
    // 小売店の画面: 第 1 週の確定後、第 2 週の状況と履歴（在庫 12 + 入荷 4 - 受注 8 = 8）
    expect(result.finalState.currentWeek).toBe(2);
    expect(result.finalState.mine).toMatchObject({ role: 'retailer', inventory: 8, receipt: 4 });
    expect(result.finalState.mine.history).toHaveLength(1);
    expect(result.confirm.teamCost).toBe(600 * 3 + 400);
    await app.close();
  });

  it('作成の応答は 201 でコードの平文を返し、キャッシュさせない', async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { name: '授業', weekCount: 5 },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(json(response).codes.joinCode).toMatch(/^[A-Z0-9]{8,}$/);
    await app.close();
  });

  it('AC1.1.1 範囲外の週数は 422 の Problem で、項目ごとの理由を返す', async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { name: '授業', weekCount: 51 },
    });
    expect(response.statusCode).toBe(422);
    const problem = json(response);
    expect(problem).toMatchObject({ kind: 'validation' });
    expect(problem.reason).toBeTypeOf('string');
    expect(problem.hint).toContain('1〜50');
    expect(problem.fields[0].path).toBe('weekCount');
    await app.close();
  });

  it('AC1.2.2 / AC1.2.3 / AC1.2.4 参加の拒否は 409（終了済み・進行中）と 403（無効なコード）', async () => {
    const { app } = await buildTestApp();
    const result = await runThinSlice(app);
    const running = await app.inject({
      method: 'POST',
      url: '/api/games/join',
      payload: { joinCode: result.joinCode, displayName: '新人' },
    });
    expect(running.statusCode).toBe(409);
    expect(json(running).kind).toBe('state');
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/games/join',
      payload: { joinCode: 'ZZZZZZZZZZ', displayName: '新人' },
    });
    expect(invalid.statusCode).toBe(403);
    expect(json(invalid).kind).toBe('forbidden');
    await app.close();
  });

  it('AC1.1.5 / AC1.4.1 参加者の token では進行役の操作ができず、他の役割の入力もできない（403）', async () => {
    const { app } = await buildTestApp();
    const result = await runThinSlice(app);
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/games/${result.gameId}/weeks/2/confirm`,
      headers: { ...bearer(result.tokens.retailer!), 'idempotency-key': newKey() },
    });
    expect(confirm.statusCode).toBe(403);
    const otherRole = await app.inject({
      method: 'PUT',
      url: `/api/games/${result.gameId}/weeks/2/decisions/factory`,
      headers: { ...bearer(result.tokens.retailer!), 'idempotency-key': newKey() },
      payload: { quantity: 3 },
    });
    expect(otherRole.statusCode).toBe(403);
    expect(otherRole.body).not.toContain('inventory');
    await app.close();
  });

  it('AC1.4.2 不正な入力は 422、BR4.8 識別子が無ければ 422（認可のあと）', async () => {
    const { app } = await buildTestApp();
    const result = await runThinSlice(app);
    const headers = { ...bearer(result.tokens.retailer!), 'idempotency-key': newKey() };
    for (const quantity of [2.5, -1, '', 'abc', null, 10000]) {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/games/${result.gameId}/weeks/2/decisions/retailer`,
        headers: { ...headers, 'idempotency-key': newKey() },
        payload: { quantity },
      });
      expect(response.statusCode, `quantity=${JSON.stringify(quantity)}`).toBe(422);
    }
    const noKey = await app.inject({
      method: 'PUT',
      url: `/api/games/${result.gameId}/weeks/2/decisions/retailer`,
      headers: bearer(result.tokens.retailer!),
      payload: { quantity: 3 },
    });
    expect(noKey.statusCode).toBe(422);
    expect(json(noKey).fields[0].path).toBe('Idempotency-Key');
    await app.close();
  });

  it('AC1.4.4 / BR4.7 同じ識別子の再送は同じ結果で、確定前は上書きできる', async () => {
    const { app } = await buildTestApp();
    const result = await runThinSlice(app);
    const send = (quantity: number, key: string) =>
      app.inject({
        method: 'PUT',
        url: `/api/games/${result.gameId}/weeks/2/decisions/retailer`,
        headers: { ...bearer(result.tokens.retailer!), 'idempotency-key': key },
        payload: { quantity },
      });
    const key = newKey('retry');
    const first = await send(10, key);
    const replay = await send(10, key);
    expect(replay.statusCode).toBe(200);
    expect(json(replay)).toEqual(json(first));
    const conflict = await send(11, key);
    expect(conflict.statusCode).toBe(409);
    expect(json(conflict).kind).toBe('conflict');
    await send(12, newKey());
    const state = await app.inject({
      method: 'GET',
      url: `/api/games/${result.gameId}/state`,
      headers: bearer(result.tokens.retailer!),
    });
    expect(json(state).mine.decision).toBe(12);
    await app.close();
  });

  it('AC1.5.1 未入力があるときの確定は 409 で、未入力の役割を示す', async () => {
    const { app } = await buildTestApp();
    const result = await runThinSlice(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/games/${result.gameId}/weeks/2/confirm`,
      headers: { ...bearer(result.facilitatorCode), 'idempotency-key': newKey() },
    });
    expect(response.statusCode).toBe(409);
    expect(json(response)).toMatchObject({
      kind: 'state',
      missingRoles: ['factory', 'wholesaler1', 'wholesaler2', 'retailer'],
    });
    await app.close();
  });

  it('進行役は全役割の状態と、参加コード・観察者用コードの再表示を取得できる', async () => {
    const { app } = await buildTestApp();
    const result = await runThinSlice(app);
    const state = await app.inject({
      method: 'GET',
      url: `/api/games/${result.gameId}/state`,
      headers: bearer(result.facilitatorCode),
    });
    expect(json(state).viewerKind).toBe('facilitator');
    expect(Object.keys(json(state).roles)).toHaveLength(4);
    const codes = await app.inject({
      method: 'GET',
      url: `/api/games/${result.gameId}/codes`,
      headers: bearer(result.facilitatorCode),
    });
    expect(json(codes).joinCode).toBe(result.joinCode);
    expect(codes.body).not.toContain(result.facilitatorCode);
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: bearer(result.tokens.wholesaler1!),
    });
    expect(json(me)).toMatchObject({
      kind: 'participant',
      gameId: result.gameId,
      role: 'wholesaler1',
    });
    await app.close();
  });

  it('週の指定が数字でない・存在しない役割の指定は拒否する', async () => {
    const { app } = await buildTestApp();
    const result = await runThinSlice(app);
    const badWeek = await app.inject({
      method: 'PUT',
      url: `/api/games/${result.gameId}/weeks/abc/decisions/retailer`,
      headers: { ...bearer(result.tokens.retailer!), 'idempotency-key': newKey() },
      payload: { quantity: 3 },
    });
    expect(badWeek.statusCode).toBe(422);
    const badRole = await app.inject({
      method: 'PUT',
      url: `/api/games/${result.gameId}/weeks/2/decisions/boss`,
      headers: { ...bearer(result.tokens.retailer!), 'idempotency-key': newKey() },
      payload: { quantity: 3 },
    });
    expect(badRole.statusCode).toBe(403);
    await app.close();
  });
});
