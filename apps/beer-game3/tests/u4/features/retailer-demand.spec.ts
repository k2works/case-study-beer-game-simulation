import { describe, expect, it } from 'vitest';
import { bootGame, buildU4App, GET, json, playWeek } from '../support/harness.js';

const DEMAND = [8, 4, 4, 6, 5, 7, 3, 4, 9, 2, 5, 6];

describe('US2.1 小売店だけが当週までの需要を見る', () => {
  it('AC2.1.1 Given 第 3 週のプレイ中 / When 小売店が状態を見る / Then 第 3 週までの値だけが見え、第 4 週以降は見えない', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app, { demandSeries: DEMAND });
    await playWeek(app, game, 1);
    await playWeek(app, game, 2);

    const response = await GET(app, `/api/games/${game.gameId}/state`, game.players.retailer.token);
    const view = json(response);
    expect(view.currentWeek).toBe(3);
    expect(view.customerDemand).toEqual([8, 4, 4]);
    // 第 4 週以降の値（6、5、7 …）が、応答のどこにも出ない
    expect(JSON.stringify(view.customerDemand)).not.toContain('6');
  });

  it('第 1 週の開始直後は、第 1 週の需要だけが見える', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app, { demandSeries: DEMAND });
    const view = json(
      await GET(app, `/api/games/${game.gameId}/state`, game.players.retailer.token),
    );
    expect(view.customerDemand).toEqual([8]);
  });

  it('BR16.1 準備中は、まだ第 1 週が始まっていないので需要は空', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app, { start: false, demandSeries: DEMAND });
    const view = json(
      await GET(app, `/api/games/${game.gameId}/state`, game.players.retailer.token),
    );
    expect(view.status).toBe('preparing');
    expect(view.customerDemand).toEqual([]);
  });

  it('AC2.1.2 Given 小売店以外の参加者と観察者 / When 状態を取得 / Then 顧客需要の項目が投影に無い', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app, { demandSeries: DEMAND });
    await playWeek(app, game, 1);
    for (const role of ['factory', 'wholesaler1', 'wholesaler2'] as const) {
      const view = json(
        await GET(app, `/api/games/${game.gameId}/state`, game.players[role].token),
      );
      expect(view, role).not.toHaveProperty('customerDemand');
    }
    const observer = json(await GET(app, `/api/games/${game.gameId}/state`, game.observerCode));
    expect(observer).not.toHaveProperty('customerDemand');
  });

  it('AC2.1.3 Given 資格情報なし、または別のゲームの資格情報 / When 状態を取得 / Then 拒否される', async () => {
    const { app } = await buildU4App();
    const first = await bootGame(app, { demandSeries: DEMAND });
    const second = await bootGame(app, { demandSeries: DEMAND });
    const anonymous = await GET(app, `/api/games/${first.gameId}/state`);
    expect(anonymous.statusCode).toBe(403);
    const crossGame = await GET(
      app,
      `/api/games/${first.gameId}/state`,
      second.players.retailer.token,
    );
    expect(crossGame.statusCode).toBe(403);
  });

  it('顧客需要の専用の経路は設けない', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app, { demandSeries: DEMAND });
    for (const url of [
      `/api/games/${game.gameId}/demand`,
      `/api/games/${game.gameId}/customer-demand`,
      `/api/games/${game.gameId}/weeks/1/demand`,
    ]) {
      const response = await GET(app, url, game.players.retailer.token);
      expect(response.statusCode, url).toBe(404);
    }
  });

  it('ゲームが終了しても、第 1 週から currentWeek までだけ見える', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app, { demandSeries: DEMAND.slice(0, 2), weekCount: 2 });
    await playWeek(app, game, 1);
    await playWeek(app, game, 2);
    const view = json(
      await GET(app, `/api/games/${game.gameId}/state`, game.players.retailer.token),
    );
    expect(view.status).toBe('ended');
    expect(view.customerDemand).toEqual([8, 4]);
  });
});
