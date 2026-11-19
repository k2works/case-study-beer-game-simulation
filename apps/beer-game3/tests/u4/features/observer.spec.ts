import { describe, expect, it } from 'vitest';
import { ROLES } from '../../../src/server/domain/types.js';
import { bearer, bootGame, buildU4App, GET, json, playWeek } from '../support/harness.js';
import { newKey } from '../../u1/support/world.js';

const OBSERVER_KEYS = [
  'currentWeek',
  'gameId',
  'inputsDone',
  'name',
  'setupKind',
  'status',
  'teamBacklog',
  'teamCumulativeCost',
  'teamInventory',
  'teamWeeklyCost',
  'version',
  'viewerKind',
  'weekCount',
];

describe('US2.9 観察者が入力できずに進行を見る', () => {
  it('AC2.9.1 Given 観察者がプレイ中のゲームを開く / When 状態を取得 / Then チーム全体の集計値と現在週だけが見える', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app);
    await playWeek(app, game, 1, { factory: 6, wholesaler1: 5, wholesaler2: 3, retailer: 8 });

    const response = await GET(app, `/api/games/${game.gameId}/state`, game.observerCode);
    expect(response.statusCode).toBe(200);
    const view = json(response);
    // 型に決めた項目だけ（余分な項目が混ざったら失敗する）
    expect(Object.keys(view).sort()).toEqual(OBSERVER_KEYS);
    expect(view).toMatchObject({ viewerKind: 'observer', status: 'running', currentWeek: 2 });

    // 合計は、進行役が見る役割ごとの値の合計と一致する（最新の確定済みの週の週末の値）
    const facilitator = json(
      await GET(app, `/api/games/${game.gameId}/state`, game.facilitatorCode),
    );
    const sum = (key: 'inventory' | 'backlog' | 'cumulativeCost') =>
      ROLES.reduce((total, role) => total + facilitator.roles[role][key], 0);
    expect(view.teamInventory).toBe(sum('inventory'));
    expect(view.teamBacklog).toBe(sum('backlog'));
    expect(view.teamCumulativeCost).toBe(sum('cumulativeCost'));
    // 第 1 週だけ確定したので、当週の費用の合計は累積と同じ
    expect(view.teamWeeklyCost).toBe(view.teamCumulativeCost);
  });

  it('AC2.9.1 役割別の値、意思決定値、受注、出荷、将来の需要、表示名、コード、token は応答に含まれない', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app);
    await playWeek(app, game, 1, { retailer: 7 });
    const response = await GET(app, `/api/games/${game.gameId}/state`, game.observerCode);
    const body = response.body;
    for (const forbidden of [
      'factory',
      'wholesaler',
      'retailer',
      'decision',
      'ordersReceived',
      'shipped',
      'demand',
      'displayName',
      'participants',
      'assignments',
      'tok_',
      'fac_',
      'obs_',
      '工場',
      '小売店',
      game.joinCode,
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it('BR15.3 確定済みの週がまだない（準備中・第 1 週の確定前）は、初期状態の合計を返す', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app, { start: false });
    const preparing = json(await GET(app, `/api/games/${game.gameId}/state`, game.observerCode));
    expect(preparing).toMatchObject({
      status: 'preparing',
      currentWeek: 1,
      inputsDone: 0,
      teamWeeklyCost: 0,
      teamCumulativeCost: 0,
      teamInventory: 4 * 12,
      teamBacklog: 0,
    });

    await app.inject({
      method: 'POST',
      url: `/api/games/${game.gameId}/start`,
      headers: game.facilitator,
    });
    const running = json(await GET(app, `/api/games/${game.gameId}/state`, game.observerCode));
    expect(running).toMatchObject({
      status: 'running',
      currentWeek: 1,
      teamCumulativeCost: 0,
      teamInventory: 4 * 12,
    });
  });

  it('BR15.3 入力済みの役割の数だけを返す（どの役割かは返さない）', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app);
    await app.inject({
      method: 'PUT',
      url: `/api/games/${game.gameId}/weeks/1/decisions/retailer`,
      headers: { ...bearer(game.players.retailer.token), 'idempotency-key': newKey('obs') },
      payload: { quantity: 5 },
    });
    const view = json(await GET(app, `/api/games/${game.gameId}/state`, game.observerCode));
    expect(view.inputsDone).toBe(1);
  });

  it('一時停止中も、終了後も、観察者は同じ形で閲覧できる', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app);
    await app.inject({
      method: 'POST',
      url: `/api/games/${game.gameId}/pause`,
      headers: game.facilitator,
    });
    const paused = json(await GET(app, `/api/games/${game.gameId}/state`, game.observerCode));
    expect(paused.status).toBe('paused');
    await app.inject({
      method: 'POST',
      url: `/api/games/${game.gameId}/end`,
      headers: game.facilitator,
    });
    const ended = json(await GET(app, `/api/games/${game.gameId}/state`, game.observerCode));
    expect(ended.status).toBe('ended');
    expect(Object.keys(ended).sort()).toEqual(OBSERVER_KEYS);
  });

  it('AC2.9.2 Given 観察者 / When 発注数の入力などの書き込みを送る / Then すべて 403 で、状態は変わらない', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app);
    const credential = bearer(game.observerCode);
    const before = json(await GET(app, `/api/games/${game.gameId}/state`, game.facilitatorCode));

    const attempts = [
      {
        method: 'PUT',
        url: `/api/games/${game.gameId}/weeks/1/decisions/retailer`,
        headers: { ...credential, 'idempotency-key': newKey('obs-write') },
        payload: { quantity: 9 },
      },
      {
        method: 'POST',
        url: `/api/games/${game.gameId}/weeks/1/confirm`,
        headers: { ...credential, 'idempotency-key': newKey('obs-confirm') },
      },
      { method: 'POST', url: `/api/games/${game.gameId}/pause`, headers: credential },
      { method: 'POST', url: `/api/games/${game.gameId}/resume`, headers: credential },
      { method: 'POST', url: `/api/games/${game.gameId}/end`, headers: credential },
      { method: 'POST', url: `/api/games/${game.gameId}/start`, headers: credential },
      { method: 'GET', url: `/api/games/${game.gameId}/history`, headers: credential },
      { method: 'GET', url: `/api/games/${game.gameId}/codes`, headers: credential },
      {
        method: 'PUT',
        url: `/api/games/${game.gameId}/assignments/${game.players.retailer.participantId}`,
        headers: credential,
        payload: { role: 'factory' },
      },
      {
        method: 'POST',
        url: `/api/games/${game.gameId}/roles/retailer/replacement`,
        headers: credential,
        payload: { participantId: game.players.retailer.participantId, displayName: '乗っ取り' },
      },
    ] as const;
    for (const attempt of attempts) {
      const response = await app.inject(attempt as never);
      expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(403);
      expect(response.json()).toMatchObject({ kind: 'forbidden' });
    }
    const after = json(await GET(app, `/api/games/${game.gameId}/state`, game.facilitatorCode));
    expect(after).toEqual(before);
  });

  it('AC2.9.3 Given 別のゲームの観察者用コード / When 状態を取得 / Then 403', async () => {
    const { app } = await buildU4App();
    const first = await bootGame(app);
    const second = await bootGame(app);
    const response = await GET(app, `/api/games/${first.gameId}/state`, second.observerCode);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ kind: 'forbidden' });
  });

  it('BR15.1 観察者用コードは、/api/me で観察者として確かめられる', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app);
    const me = json(await GET(app, '/api/me', game.observerCode));
    expect(me).toEqual({ kind: 'observer', gameId: game.gameId });
  });

  it('BR18.1 観察者用コードの無効な試行は、参加の窓に数えない', async () => {
    const { app, store } = await buildU4App();
    const game = await bootGame(app);
    for (let i = 0; i < 15; i += 1) {
      const response = await GET(app, `/api/games/${game.gameId}/state`, `obs_wrong-${i}`);
      expect(response.statusCode).toBe(403);
    }
    expect(await store.countJoinAttempts()).toBe(0);
  });
});
