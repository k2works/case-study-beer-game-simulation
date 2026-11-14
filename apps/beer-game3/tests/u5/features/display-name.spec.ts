import { describe, expect, it } from 'vitest';
import { parseJoin, parseReplacement } from '../../../src/server/session/schemas.js';
import { AppError } from '../../../src/server/errors.js';
import { expectProblem } from '../../u3/support/helpers.js';
import { buildU4App, bootGame, json } from '../support/harness.js';
import { createWorld } from '../../u1/support/world.js';

const FORBIDDEN_STARTS: Array<[string, string]> = [
  ['= で始まる', '=1+1'],
  ['+ で始まる', '+81-90-0000-0000'],
  ['- で始まる', '-2+3'],
  ['@ で始まる', '@SUM(A1:A9)'],
  ['先頭に空白のあと =', '   =cmd'],
  ['先頭がタブのあと =', '\t=cmd'],
  ['先頭が復帰のあと +', '\r+1'],
];

describe('BR23.10 表示名の先頭が式になる文字（= + - @ タブ 復帰）は参加と入れ替えで拒否する', () => {
  it.each(FORBIDDEN_STARTS)(
    '参加: 表示名が %s は 422 で、理由と直し方を示す',
    async (_label, name) => {
      const world = createWorld();
      const game = await world.createGame();
      const error = await expectProblem(
        world.session.joinGame({ joinCode: game.joinCode, displayName: name }),
        'validation',
      );
      expect(error.problem.reason).toContain('表示名の先頭に使えない文字があります');
      expect(error.problem.hint).toBe('= + - @ 以外の文字で始まる名前にしてください');
      expect(error.problem.fields).toEqual([
        { path: 'displayName', message: '表示名の先頭に使えない文字があります' },
      ]);
    },
  );

  it.each(FORBIDDEN_STARTS)('入れ替え: 表示名が %s は 422', async (_label, name) => {
    const world = createWorld();
    const game = await world.startedGame({ weekCount: 4 });
    await expectProblem(
      world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', {
        participantId: game.players.retailer.participantId,
        displayName: name,
      }),
      'validation',
    );
    // 拒否されたので、担当者は入れ替わっていない
    const state = await world.session.getState(game.facilitator, game.gameId);
    expect(state.assignees?.find((a) => a.role === 'retailer')?.participantId).toBe(
      game.players.retailer.participantId,
    );
  });

  it('参加と入れ替えは、同じ表示名のスキーマを使う（1 か所の定義）', () => {
    for (const [, name] of FORBIDDEN_STARTS) {
      expect(() => parseJoin({ joinCode: 'ABCDEFGH', displayName: name })).toThrow(AppError);
      expect(() =>
        parseReplacement({
          participantId: '11111111-1111-4111-8111-111111111111',
          displayName: name,
        }),
      ).toThrow(AppError);
    }
  });

  it('途中や末尾にある文字、日本語、数字で始まる名前は受け付ける', async () => {
    const world = createWorld();
    const game = await world.createGame();
    for (const name of ['太郎=', 'A-1', '田中 +', '1+1', '＝全角', '😀']) {
      const joined = await world.session.joinGame({ joinCode: game.joinCode, displayName: name });
      expect(joined.displayName).toBe(name);
    }
  });

  it('保存済みの表示名は変えない（拒否は入力のときだけ）', async () => {
    const world = createWorld();
    const game = await world.createGame();
    await world.store.transact(game.gameId, async (tx) => {
      const current = tx.game();
      await tx.addParticipant(
        {
          participantId: '22222222-2222-4222-8222-222222222222',
          gameId: game.gameId,
          displayName: '=旧名',
          joinOrder: 1,
          joinedAt: new Date('2026-01-01T00:00:00Z'),
          replacedAt: null,
          createdByFacilitator: false,
        },
        'sha256:legacy',
        new Date('2026-01-01T00:00:00Z'),
      );
      await tx.updateGame({}, current.version, []);
    });
    await world.joinOne(game.joinCode, '新しい人');
    const snapshot = await world.store.readSnapshot(game.gameId);
    expect(snapshot!.participants.map((p) => p.displayName)).toEqual(['=旧名', '新しい人']);
  });

  it('HTTP: 参加の要求で先頭が = の表示名は 422、フィールドごとの理由を返す', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app, { start: false });
    const response = await app.inject({
      method: 'POST',
      url: '/api/games/join',
      payload: { joinCode: game.joinCode, displayName: '=cmd|calc' },
    });
    expect(response.statusCode).toBe(422);
    const body = json(response);
    expect(body.kind).toBe('validation');
    expect(body.fields).toEqual([
      { path: 'displayName', message: '表示名の先頭に使えない文字があります' },
    ]);
  });

  it('HTTP: 進行中のゲームでも、形式の誤りは占有の前に 422（状態の 409 より先）', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/games/join',
      payload: { joinCode: game.joinCode, displayName: '@x' },
    });
    expect(response.statusCode).toBe(422);
  });
});
