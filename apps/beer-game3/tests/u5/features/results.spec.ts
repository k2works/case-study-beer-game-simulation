import { describe, expect, it } from 'vitest';
import { ROLES } from '../../../src/server/domain/types.js';
import { newKey } from '../../u1/support/world.js';
import {
  bearer,
  bootGame,
  buildU4App,
  getResults,
  json,
  playWeek,
  quantitiesOf,
  type Booted,
  type Json,
  type U4App,
} from '../support/harness.js';

const DEMAND = [8, 4, 6];

/** HTTP の入口だけで N 週を確定し、各週の確定の応答も返す。 */
async function playAll(app: U4App['app'], weeks: number, weekCount = weeks) {
  const game = await bootGame(app, {
    weekCount,
    demandSeries: Array.from({ length: weekCount }, (_, i) => DEMAND[i % DEMAND.length]!),
  });
  const confirms: Json[] = [];
  for (let week = 1; week <= weeks; week += 1) {
    confirms.push(await playWeek(app, game, week, quantitiesOf(week)));
  }
  return { game, confirms };
}

const endGame = (app: U4App['app'], game: Booted) =>
  app.inject({ method: 'POST', url: `/api/games/${game.gameId}/end`, headers: game.facilitator });

describe('US4.1 AC4.1.1 終了後に全役割の需要、注文、在庫、受注残、出荷、費用の時系列が見える', () => {
  it('Given 終了したゲーム / When 参加者が結果を開く / Then 4 役割の確定済みの週の値が、確定のときの値と一致する', async () => {
    const { app } = await buildU4App();
    const { game, confirms } = await playAll(app, 3);

    const response = await getResults(app, game.gameId, game.players.retailer.token);

    expect(response.statusCode).toBe(200);
    const view = json(response);
    expect(view).toMatchObject({
      gameId: game.gameId,
      setupKind: 'custom',
      weekCount: 3,
      confirmedWeeks: 3,
      customerDemand: DEMAND,
    });
    expect(view.roles.map((r: Json) => r.role)).toEqual([...ROLES]);
    for (const role of view.roles as Json[]) {
      expect(role.weeks).toHaveLength(3);
      for (const week of role.weeks as Json[]) {
        const confirmed = (confirms[week.week - 1]!.results as Json[]).find(
          (r) => r.role === role.role,
        )!;
        expect(week).toEqual({
          week: week.week,
          receipt: confirmed.receipt,
          ordersReceived: confirmed.ordersReceived,
          shipped: confirmed.shipped,
          inventory: confirmed.inventory,
          backlog: confirmed.backlog,
          decision: confirmed.decision,
          weeklyCost: confirmed.weeklyCost,
          cumulativeCost: confirmed.cumulativeCost,
        });
      }
    }
    const lastWeek = confirms[2]!.results as Json[];
    expect(view.teamCumulativeCost).toBe(
      lastWeek.reduce((sum: number, r: Json) => sum + (r.cumulativeCost as number), 0),
    );
  });

  it('進行役も同じ結果を見られる', async () => {
    const { app } = await buildU4App();
    const { game } = await playAll(app, 3);
    const asPlayer = json(await getResults(app, game.gameId, game.players.factory.token));
    const asFacilitator = await getResults(app, game.gameId, game.facilitatorCode);
    expect(asFacilitator.statusCode).toBe(200);
    expect(json(asFacilitator)).toEqual(asPlayer);
  });

  it('BR21.4 結果に表示名、コード、token、冪等の識別子を含めない', async () => {
    const { app } = await buildU4App();
    const { game } = await playAll(app, 3);
    const body = (await getResults(app, game.gameId, game.facilitatorCode)).body;
    for (const secret of [
      game.joinCode,
      game.facilitatorCode,
      game.observerCode,
      ...ROLES.map((role) => game.players[role].token),
      ...ROLES.map((role) => game.players[role].participantId),
      'idempotency',
      'sha256',
    ]) {
      expect(body).not.toContain(secret);
    }
    for (const label of ['工場', '一次卸', '二次卸', '小売店']) {
      expect(body).not.toContain(label);
    }
  });

  it('BR21.3 途中で終了したゲームは確定済みの週までを返し、確定前の入力は含めない', async () => {
    const { app } = await buildU4App();
    const { game } = await playAll(app, 2, 6);
    await app.inject({
      method: 'PUT',
      url: `/api/games/${game.gameId}/weeks/3/decisions/factory`,
      headers: { ...bearer(game.players.factory.token), 'idempotency-key': newKey('early') },
      payload: { quantity: 9 },
    });
    expect((await endGame(app, game)).statusCode).toBe(200);

    const view = json(await getResults(app, game.gameId, game.players.wholesaler1.token));

    expect(view.confirmedWeeks).toBe(2);
    expect(view.customerDemand).toHaveLength(2);
    expect(view.weekCount).toBe(6);
    for (const role of view.roles as Json[]) {
      expect((role.weeks as Json[]).map((w) => w.week)).toEqual([1, 2]);
    }
  });

  it('BR21.3 確定済みの週が 1 つもないゲームは、エラーにせず、空の系列と 0 を返す', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app, { weekCount: 4, demandSeries: [4, 4, 4, 4] });
    await endGame(app, game);
    const response = await getResults(app, game.gameId, game.players.retailer.token);
    expect(response.statusCode).toBe(200);
    const view = json(response);
    expect(view).toMatchObject({ confirmedWeeks: 0, customerDemand: [], teamCumulativeCost: 0 });
    expect((view.roles as Json[]).every((role) => role.weeks.length === 0)).toBe(true);
    expect(view.roles).toHaveLength(4);
  });

  it('BR21.5 結果の取得は読み取りだけ: 版、履歴の件数、最後の操作の時刻は変わらない', async () => {
    const { app, store, clock } = await buildU4App();
    const { game } = await playAll(app, 3);
    const before = await store.readSnapshot(game.gameId);
    const historyBefore = (await store.readHistory(game.gameId)).length;
    clock.advance(60_000);
    await getResults(app, game.gameId, game.facilitatorCode);
    await getResults(app, game.gameId, game.players.retailer.token);
    const after = await store.readSnapshot(game.gameId);
    expect(after!.game.version).toBe(before!.game.version);
    expect(after!.game.lastOperationAt).toEqual(before!.game.lastOperationAt);
    expect((await store.readHistory(game.gameId)).length).toBe(historyBefore);
  });

  it('結果の応答は Cache-Control: no-store で、取得のログに種類と大きさだけを出す', async () => {
    const { app, logs } = await buildU4App();
    const { game } = await playAll(app, 3);
    const response = await getResults(app, game.gameId, game.facilitatorCode);
    expect(response.headers['cache-control']).toBe('no-store');
    const served = logs.find((line) => line.event === 'results_served');
    expect(served).toMatchObject({ kind: 'results', gameId: game.gameId, rows: 12 });
    expect(typeof served!.durationMs).toBe('number');
    expect(JSON.stringify(served)).not.toContain(game.facilitatorCode);
  });
});

describe('US4.1 AC4.1.4 プレイ中は他役割の時系列を開示しない', () => {
  it('Given 進行中のゲーム / When 参加者が結果を要求する / Then 403 で、他役割の値も週の数も含まない', async () => {
    const { app } = await buildU4App();
    const { game } = await playAll(app, 2, 5);

    for (const credential of [game.players.retailer.token, game.facilitatorCode]) {
      const response = await getResults(app, game.gameId, credential);
      expect(response.statusCode).toBe(403);
      const body = json(response);
      expect(body).toMatchObject({
        kind: 'forbidden',
        reason: 'ゲームが終了するまで、結果は見られません',
      });
      expect(Object.keys(body).sort()).toEqual(['hint', 'kind', 'reason']);
      expect(response.body).not.toMatch(/confirmedWeeks|weeks|roles|customerDemand|weekCount/);
    }
  });

  it('準備中と一時停止中のゲームでも、同じ理由で拒否する', async () => {
    const { app } = await buildU4App();
    const preparing = await bootGame(app, { start: false });
    const paused = await bootGame(app);
    await app.inject({
      method: 'POST',
      url: `/api/games/${paused.gameId}/pause`,
      headers: paused.facilitator,
    });
    for (const game of [preparing, paused]) {
      const response = await getResults(app, game.gameId, game.players.retailer.token);
      expect(response.statusCode).toBe(403);
      expect(json(response).reason).toBe('ゲームが終了するまで、結果は見られません');
    }
  });
});

describe('BR21.2 結果を見られるのは、そのゲームの参加者と進行役だけ', () => {
  it('観察者、資格情報なし、壊れた資格情報、別のゲームは、同じ 403 の本文で拒否する', async () => {
    const { app } = await buildU4App();
    const { game } = await playAll(app, 3);
    const { game: other } = await playAll(app, 3);

    const none = await getResults(app, game.gameId);
    expect(none.statusCode).toBe(403);
    for (const credential of [
      'tok_garbage',
      game.observerCode,
      other.facilitatorCode,
      other.observerCode,
      other.players.retailer.token,
    ]) {
      const response = await getResults(app, game.gameId, credential);
      expect(response.statusCode, credential).toBe(403);
      expect(response.json()).toEqual(none.json());
    }
  });

  it('存在しないゲームも、同じ 403（存在を明かさない）', async () => {
    const { app } = await buildU4App();
    const { game } = await playAll(app, 3);
    const none = await getResults(app, game.gameId);
    const missing = await getResults(
      app,
      '99999999-9999-4999-8999-999999999999',
      game.facilitatorCode,
    );
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toEqual(none.json());
  });

  it('入れ替えで失効した旧担当者の token は、結果を見られない', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app, { weekCount: 3, demandSeries: [4, 4, 4] });
    await playWeek(app, game, 1);
    const replaced = await app.inject({
      method: 'POST',
      url: `/api/games/${game.gameId}/roles/retailer/replacement`,
      headers: game.facilitator,
      payload: { participantId: game.players.retailer.participantId, displayName: '交代した人' },
    });
    expect(replaced.statusCode).toBe(201);
    await app.inject({
      method: 'POST',
      url: `/api/games/${game.gameId}/end`,
      headers: game.facilitator,
    });
    const old = await getResults(app, game.gameId, game.players.retailer.token);
    expect(old.statusCode).toBe(403);
    const fresh = await getResults(app, game.gameId, json(replaced).token);
    expect(fresh.statusCode).toBe(200);
  });
});
