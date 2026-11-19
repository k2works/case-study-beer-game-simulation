import { describe, expect, it } from 'vitest';
import { routeCatalog, type RouteSpec } from '../../../src/server/http/routes.js';
import { bearer, bootGame, buildU4App, type Booted } from '../support/harness.js';
import { newKey } from '../../u1/support/world.js';

const MISSING_GAME = '99999999-9999-4999-8999-999999999999';
const GUARDED = routeCatalog.filter((row) => row.action !== 'public');

function urlFor(row: RouteSpec, game: { gameId: string }, participantId: string, role: string) {
  return row.url
    .replace(':gameId', game.gameId)
    .replace(':participantId', participantId)
    .replace(':week', '1')
    .replace(':role', role);
}

interface Actor {
  label: string;
  headers: Record<string, string>;
  /** 経路が役割を指定するとき、このアクターが権限を持たない役割 */
  role?: string;
  gameId?: string;
}

describe('BR19.3 全経路の拒否の網羅（経路の表から作る）', () => {
  it('表は、公開の経路（作成・参加・ヘルスチェック）以外のすべての経路を含む', () => {
    expect(GUARDED.length).toBeGreaterThanOrEqual(12);
    expect(
      routeCatalog
        .filter((row) => row.action === 'public')
        .map((r) => r.url)
        .sort(),
    ).toEqual(['/api/games', '/api/games/join', '/health']);
  });

  it('無資格、別のゲーム、存在しないゲーム、別の役割、観察者の、すべての場合で 403 になる（本文が不正でも）', async () => {
    const { app } = await buildU4App();
    const game: Booted = await bootGame(app);
    const other: Booted = await bootGame(app);

    const actors: Actor[] = [
      { label: '無資格', headers: {} },
      { label: '壊れた資格情報', headers: bearer('tok_garbage') },
      { label: '別のゲームの進行役', headers: bearer(other.facilitatorCode) },
      { label: '別のゲームの参加者', headers: bearer(other.players.retailer.token) },
      { label: '別のゲームの観察者', headers: bearer(other.observerCode) },
      { label: '観察者', headers: bearer(game.observerCode) },
      { label: '別の役割の参加者', headers: bearer(game.players.factory.token), role: 'retailer' },
    ];

    let checked = 0;
    for (const row of GUARDED) {
      // 状態の取得は観察者に許し、自分が誰かの確認は有効な資格情報すべてに許す
      for (const actor of actors) {
        if (row.action === 'viewState' && actor.label === '観察者') {
          continue;
        }
        if (
          row.action === 'identify' &&
          actor.label !== '無資格' &&
          actor.label !== '壊れた資格情報'
        ) {
          continue;
        }
        if (actor.role && !row.url.includes(':role')) {
          continue;
        }
        const url = urlFor(
          row,
          game,
          game.players.retailer.participantId,
          actor.role ?? 'retailer',
        );
        const attempts = [
          { payload: undefined as unknown },
          {
            payload: { quantity: 'not-a-number', role: 'nope', participantId: 3, displayName: '' },
          },
        ];
        for (const attempt of attempts) {
          const response = await app.inject({
            method: row.method,
            url,
            headers: { ...actor.headers, 'idempotency-key': newKey('matrix') },
            ...(attempt.payload !== undefined ? { payload: attempt.payload as object } : {}),
          });
          expect(response.statusCode, `${row.method} ${row.url} / ${actor.label}`).toBe(403);
          expect(response.json()).toMatchObject({ kind: 'forbidden' });
          checked += 1;
        }
      }
      if (row.url.includes(':gameId')) {
        // 存在しないゲームは、別のゲームと同じ 403（404 で存在を明かさない）
        const url = urlFor(
          row,
          { gameId: MISSING_GAME },
          game.players.retailer.participantId,
          'retailer',
        );
        const response = await app.inject({
          method: row.method,
          url,
          headers: { ...game.facilitator, 'idempotency-key': newKey('matrix') },
        });
        expect(response.statusCode, `${row.method} ${row.url} / 存在しないゲーム`).toBe(403);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('壊れた JSON の本文を、権限のない人が送っても 422 でなく 403', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/games/${game.gameId}/weeks/1/decisions/retailer`,
      headers: { ...bearer(game.observerCode), 'content-type': 'application/json' },
      payload: '{ this is not json',
    });
    expect(response.statusCode).toBe(403);
  });

  it('権限のない人は、週の指定の誤りや状態の不一致でも 422 / 409 の違いを見られない', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app);
    const credential = bearer(game.players.factory.token);
    const badWeek = await app.inject({
      method: 'POST',
      url: `/api/games/${game.gameId}/weeks/abc/confirm`,
      headers: { ...credential, 'idempotency-key': newKey('matrix') },
    });
    expect(badWeek.statusCode).toBe(403);
    const wrongWeek = await app.inject({
      method: 'POST',
      url: `/api/games/${game.gameId}/weeks/30/confirm`,
      headers: { ...credential, 'idempotency-key': newKey('matrix') },
    });
    expect(wrongWeek.statusCode).toBe(403);
    // 同じ要求を進行役が送れば、認可を通ったうえで 422 / 409 になる
    const asFacilitator = await app.inject({
      method: 'POST',
      url: `/api/games/${game.gameId}/weeks/abc/confirm`,
      headers: { ...game.facilitator, 'idempotency-key': newKey('matrix') },
    });
    expect(asFacilitator.statusCode).toBe(422);
  });

  it('AC5.4.1 他のゲームの役割の識別子: 別のゲームの参加者の token では、そのゲームの役割の入力が通らない', async () => {
    const { app } = await buildU4App();
    const mine = await bootGame(app);
    const theirs = await bootGame(app);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/games/${theirs.gameId}/weeks/1/decisions/retailer`,
      headers: { ...bearer(mine.players.retailer.token), 'idempotency-key': newKey('cross') },
      payload: { quantity: 9 },
    });
    expect(response.statusCode).toBe(403);
    // 相手のゲームの状態は変わっていない
    const state = await app.inject({
      method: 'GET',
      url: `/api/games/${theirs.gameId}/state`,
      headers: bearer(theirs.players.retailer.token),
    });
    expect(state.json().mine.decision).toBeNull();
  });

  it('有効な資格情報を持つ本来の呼び出し手は、通る（表が拒否一辺倒でないことの確認）', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app);
    const ok = await app.inject({
      method: 'PUT',
      url: `/api/games/${game.gameId}/weeks/1/decisions/retailer`,
      headers: { ...bearer(game.players.retailer.token), 'idempotency-key': newKey('ok') },
      payload: { quantity: 3 },
    });
    expect(ok.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: game.facilitator });
    expect(me.json()).toEqual({ kind: 'facilitator', gameId: game.gameId });
  });
});
