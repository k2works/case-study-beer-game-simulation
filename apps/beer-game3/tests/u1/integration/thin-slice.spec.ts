import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, buildTestApp, json, runThinSlice, type TestApp } from '../support/app.js';
import { newPgStore, rawPool, resetDatabase } from '../support/pg.js';
import { newKey } from '../support/world.js';

let testApp: TestApp;
const pool = rawPool();

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase();
  testApp = await buildTestApp({ store: newPgStore(500) });
});

describe('薄い一通り（実際の PostgreSQL・HTTP の入口から）', () => {
  it('作成 → 4 人の参加 → 割当て → 開始 → 4 役割の入力 → 確定 → 役割別の状態の表示', async () => {
    const result = await runThinSlice(testApp.app);
    // 第 1 週: 小売店は需要 8 に対して在庫 12 + 入荷 4 - 8 = 8
    expect(result.finalState).toMatchObject({
      status: 'running',
      currentWeek: 2,
      viewerKind: 'participant',
      role: 'retailer',
    });
    expect(result.finalState.mine).toMatchObject({ inventory: 8, receipt: 4, cumulativeCost: 400 });
    // 小売店の在庫 8（費用 400）と、ほかの 3 役割の在庫 12（費用 600 ずつ）
    expect(result.confirm.teamCost).toBe(600 * 3 + 400);

    // 進行役は全役割の状態を見られ、参加者は自分の役割だけ
    const facilitatorView = json(
      await testApp.app.inject({
        method: 'GET',
        url: `/api/games/${result.gameId}/state`,
        headers: bearer(result.facilitatorCode),
      }),
    );
    expect(Object.keys(facilitatorView.roles).sort()).toEqual([
      'factory',
      'retailer',
      'wholesaler1',
      'wholesaler2',
    ]);
    const factoryView = json(
      await testApp.app.inject({
        method: 'GET',
        url: `/api/games/${result.gameId}/state`,
        headers: bearer(result.tokens.factory!),
      }),
    );
    expect(factoryView).not.toHaveProperty('roles');
    expect(JSON.stringify(factoryView)).not.toContain('retailer');
    await testApp.app.close();
  });

  it('再起動の代わりに別のアプリを立てても、保存済みの token で同じ状態に入り直せる（復元）', async () => {
    const result = await runThinSlice(testApp.app);
    await testApp.app.inject({
      method: 'PUT',
      url: `/api/games/${result.gameId}/weeks/2/decisions/retailer`,
      headers: { ...bearer(result.tokens.retailer!), 'idempotency-key': newKey() },
      payload: { quantity: 11 },
    });
    await testApp.app.close();
    const restarted = await buildTestApp({ store: newPgStore() });
    const view = json(
      await restarted.app.inject({
        method: 'GET',
        url: `/api/games/${result.gameId}/state`,
        headers: bearer(result.tokens.retailer!),
      }),
    );
    expect(view.currentWeek).toBe(2);
    expect(view.mine.decision).toBe(11);
    expect(view.mine.history).toHaveLength(1);
    await restarted.app.close();
  });

  it('4 役割が同時に入力しても、すべて保存され、確定は 1 回だけで、ログに資格情報が出ない', async () => {
    const result = await runThinSlice(testApp.app);
    const roles = ['factory', 'wholesaler1', 'wholesaler2', 'retailer'] as const;
    const inputs = await Promise.all(
      roles.map((role, index) =>
        testApp.app.inject({
          method: 'PUT',
          url: `/api/games/${result.gameId}/weeks/2/decisions/${role}`,
          headers: { ...bearer(result.tokens[role]!), 'idempotency-key': newKey(`par-${role}`) },
          payload: { quantity: 5 + index },
        }),
      ),
    );
    expect(inputs.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    const confirms = await Promise.all(
      [1, 2, 3].map((n) =>
        testApp.app.inject({
          method: 'POST',
          url: `/api/games/${result.gameId}/weeks/2/confirm`,
          headers: {
            ...bearer(result.facilitatorCode),
            'idempotency-key': newKey(`par-confirm-${n}`),
          },
        }),
      ),
    );
    expect(confirms.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(confirms.filter((r) => r.statusCode === 409)).toHaveLength(2);
    const state = json(
      await testApp.app.inject({
        method: 'GET',
        url: `/api/games/${result.gameId}/state`,
        headers: bearer(result.tokens.retailer!),
      }),
    );
    expect(state.currentWeek).toBe(3);
    expect(JSON.stringify(testApp.logs)).not.toContain(result.facilitatorCode);
    for (const token of Object.values(result.tokens)) {
      expect(JSON.stringify(testApp.logs)).not.toContain(token);
    }
    await testApp.app.close();
  });

  it('3 週のゲームを最後まで通すと終了になり、終了後の参加は拒否される（AC1.2.2）', async () => {
    const result = await runThinSlice(testApp.app);
    const roles = ['factory', 'wholesaler1', 'wholesaler2', 'retailer'] as const;
    for (const week of [2, 3]) {
      for (const role of roles) {
        await testApp.app.inject({
          method: 'PUT',
          url: `/api/games/${result.gameId}/weeks/${week}/decisions/${role}`,
          headers: { ...bearer(result.tokens[role]!), 'idempotency-key': newKey() },
          payload: { quantity: 4 },
        });
      }
      const confirm = await testApp.app.inject({
        method: 'POST',
        url: `/api/games/${result.gameId}/weeks/${week}/confirm`,
        headers: { ...bearer(result.facilitatorCode), 'idempotency-key': newKey() },
      });
      expect(confirm.statusCode).toBe(200);
    }
    const view = json(
      await testApp.app.inject({
        method: 'GET',
        url: `/api/games/${result.gameId}/state`,
        headers: bearer(result.tokens.retailer!),
      }),
    );
    expect(view).toMatchObject({ status: 'ended', currentWeek: 3 });
    expect(view.mine.history).toHaveLength(3);
    const join = await testApp.app.inject({
      method: 'POST',
      url: '/api/games/join',
      payload: { joinCode: result.joinCode, displayName: '遅刻' },
    });
    expect(join.statusCode).toBe(409);
    expect(json(join).reason).toContain('終了済み');
    const health = await testApp.app.inject({ method: 'GET', url: '/health' });
    expect(json(health)).toEqual({ status: 'ok', database: 'ok' });
    await testApp.app.close();
  });

  it('NFR3.1 入力の保存の応答（1 チーム分、4 役割 × 10 回）は、95 パーセンタイルで 1 秒以内', async () => {
    const result = await runThinSlice(testApp.app);
    const roles = ['factory', 'wholesaler1', 'wholesaler2', 'retailer'] as const;
    const elapsed: number[] = [];
    for (let round = 0; round < 10; round += 1) {
      for (const role of roles) {
        const started = performance.now();
        const response = await testApp.app.inject({
          method: 'PUT',
          url: `/api/games/${result.gameId}/weeks/2/decisions/${role}`,
          headers: { ...bearer(result.tokens[role]!), 'idempotency-key': newKey(`perf-${role}`) },
          payload: { quantity: round },
        });
        elapsed.push(performance.now() - started);
        expect(response.statusCode).toBe(200);
      }
    }
    elapsed.sort((a, b) => a - b);
    const p95 = elapsed[Math.ceil(elapsed.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(1000);
    await testApp.app.close();
  });

  it('NFR4.1 15 チームのゲームを並行して処理でき、互いの結果が混ざらない', async () => {
    const results = await Promise.all(Array.from({ length: 15 }, () => runThinSlice(testApp.app)));
    expect(new Set(results.map((r) => r.gameId)).size).toBe(15);
    for (const result of results) {
      expect(result.finalState).toMatchObject({ currentWeek: 2, role: 'retailer' });
      expect(result.finalState.mine.inventory).toBe(8);
    }
    await testApp.app.close();
  }, 60_000);
});
