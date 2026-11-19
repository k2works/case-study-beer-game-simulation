import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  buildRig,
  buildU4App,
  finishedGame,
  getExport,
  getResults,
  type Rig,
} from '../support/harness.js';
import type { StartedGame } from '../../u1/support/world.js';

type State = 'preparing' | 'running' | 'paused' | 'ended' | 'deleted';
const STATES: State[] = ['preparing', 'running', 'paused', 'ended', 'deleted'];

async function gameIn(rig: Rig, state: State): Promise<StartedGame> {
  const { world } = rig;
  switch (state) {
    case 'preparing': {
      const game = await world.createGame({ weekCount: 4 });
      const players = await world.populate(game);
      return { ...game, players };
    }
    case 'running':
      return world.startedGame({ weekCount: 4 });
    case 'paused': {
      const game = await world.startedGame({ weekCount: 4 });
      await world.session.pauseGame(game.facilitator, game.gameId);
      return game;
    }
    case 'ended':
      return finishedGame(world, 3);
    case 'deleted': {
      const game = await finishedGame(world, 3);
      world.clock.advance(31 * DAY_MS);
      await rig.job.runOnce();
      return game;
    }
  }
}

/**
 * 資格情報の種類 × ゲームの状態の、全組み合わせ（NFR6.1）。
 * 期待値は、表の形（rules.md BR21.1、BR21.2、BR23.1）をそのまま書く。
 */
describe('NFR6.1 結果と出力の認可: 資格情報の種類 × ゲームの状態の全組み合わせ', () => {
  it('結果（viewResults）と出力（exportGame）が、表のとおりに応答する', async () => {
    const rig = buildRig();
    // 時刻の進行（deleted）が他の状態の判定に影響しないよう、先に deleted を作ってから、ほかを作る
    const games = {} as Record<State, StartedGame>;
    games.deleted = await gameIn(rig, 'deleted');
    for (const state of STATES.filter((s) => s !== 'deleted')) {
      games[state] = await gameIn(rig, state);
    }
    // 別のゲーム（どの状態のゲームとも別の、終了済みのゲーム）の資格情報
    const stranger = await finishedGame(rig.world, 3);
    const { app } = await buildU4App({ store: rig.store, clock: rig.world.clock });
    const noCredential = (await getResults(app, games.ended.gameId)).json();

    let combinations = 0;
    for (const state of STATES) {
      const game = games[state];
      const credentials = {
        なし: undefined,
        壊れた: 'tok_garbage',
        参加者: game.players.retailer.token,
        別のゲームの参加者: stranger.players.retailer.token,
        進行役: game.facilitatorCode,
        別のゲームの進行役: stranger.facilitatorCode,
        観察者: game.observerCode,
        別のゲームの観察者: stranger.observerCode,
      };
      for (const [label, credential] of Object.entries(credentials)) {
        const where = `${state} / ${label}`;
        const results = await getResults(app, game.gameId, credential);
        const exported = await getExport(app, game.gameId, credential, 'csv');

        const mayView = state !== 'deleted' && (label === '参加者' || label === '進行役');
        const mayExport = state !== 'deleted' && label === '進行役';

        if (!mayView) {
          expect(results.statusCode, `結果 ${where}`).toBe(403);
          expect(results.json(), `結果 ${where}`).toEqual(noCredential);
        } else if (state === 'ended') {
          expect(results.statusCode, `結果 ${where}`).toBe(200);
        } else {
          expect(results.statusCode, `結果 ${where}`).toBe(403);
          expect(results.json().reason, `結果 ${where}`).toBe(
            'ゲームが終了するまで、結果は見られません',
          );
        }

        if (!mayExport) {
          expect(exported.statusCode, `出力 ${where}`).toBe(403);
          expect(exported.json(), `出力 ${where}`).toEqual(noCredential);
        } else if (state === 'ended') {
          expect(exported.statusCode, `出力 ${where}`).toBe(200);
        } else {
          expect(exported.statusCode, `出力 ${where}`).toBe(409);
        }
        combinations += 2;
      }
    }
    expect(combinations).toBe(5 * 8 * 2);
  });
});
