import { describe, expect, it } from 'vitest';
import { createWorld, newKey, type World } from '../../u1/support/world.js';
import { expectProblem } from '../support/helpers.js';

/** 小売店に 2 人（A=先に参加、B=あとに参加）が就いた、開始済みのゲーム。 */
async function sharedRetailerGame(world: World) {
  const game = await world.createGame({ weekCount: 6 });
  const players = await world.populate(game);
  const second = await world.joinOne(game.joinCode, '次郎');
  await world.session.assignRole(game.facilitator, game.gameId, second.participantId, 'retailer');
  const secondPrincipal = await world.as(second.token);
  await world.session.startGame(game.facilitator, game.gameId);
  return { game, players, a: players.retailer, b: { ...second, principal: secondPrincipal } };
}

describe('代理入力（US2.7）', () => {
  it('AC2.7.1 Given 工場の参加者が不在 / When 進行役が生産要請数 8 を代理入力する / Then 値が入り、履歴に進行役・工場・時刻・8 が残る', async () => {
    const world = createWorld();
    const game = await world.startedGame();
    world.clock.advance(5_000);
    const result = await world.session.submitDecision(
      game.facilitator,
      game.gameId,
      1,
      'factory',
      { quantity: 8 },
      newKey(),
    );
    expect(result).toMatchObject({ week: 1, role: 'factory', quantity: 8 });
    const snapshot = await world.store.readSnapshot(game.gameId);
    const record = snapshot!.weekRecords.find((r) => r.week === 1 && r.role === 'factory');
    expect(record).toMatchObject({
      decision: 8,
      decidedByKind: 'facilitator',
      decidedByParticipantId: null,
      decisionRevision: 1,
    });
    const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
    expect(entries.at(-1)).toMatchObject({
      kind: 'proxyInput',
      actorKind: 'facilitator',
      week: 1,
      role: 'factory',
      occurredAt: '2026-11-12T09:00:05.000Z',
      detail: { value: 8 },
    });
  });

  it('BR11.2 担当者がいる役割にも代理入力でき、担当者が確定前に上書きでき、最後の入力が有効（版は増え続ける）', async () => {
    const world = createWorld();
    const game = await world.startedGame();
    const retailer = game.players.retailer;
    await world.session.submitDecision(
      retailer.principal,
      game.gameId,
      1,
      'retailer',
      { quantity: 4 },
      newKey(),
    );
    await world.session.submitDecision(
      game.facilitator,
      game.gameId,
      1,
      'retailer',
      { quantity: 9 },
      newKey(),
    );
    let view = await world.session.getState(retailer.principal, game.gameId);
    expect(view.mine).toMatchObject({
      decision: 9,
      decisionRevision: 2,
      decidedBy: { kind: 'facilitator', label: '進行役' },
    });
    await world.session.submitDecision(
      retailer.principal,
      game.gameId,
      1,
      'retailer',
      { quantity: 5 },
      newKey(),
    );
    view = await world.session.getState(retailer.principal, game.gameId);
    expect(view.mine).toMatchObject({
      decision: 5,
      decisionRevision: 3,
      decidedBy: { kind: 'participant', label: '小売店 #4', participantId: retailer.participantId },
    });
    // 参加者の通常の入力は履歴に含めない（BR11.3）。代理入力の 1 件だけ
    const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
    expect(entries.filter((e) => e.kind === 'proxyInput')).toHaveLength(1);
  });

  it('BR11.1 値が範囲外（-1、10000、1.5、文字）→ 422 validation で、入力も履歴も残らない', async () => {
    const world = createWorld();
    const game = await world.startedGame();
    for (const quantity of [-1, 10000, 1.5, '8']) {
      await expectProblem(
        world.session.submitDecision(
          game.facilitator,
          game.gameId,
          1,
          'factory',
          { quantity },
          newKey(),
        ),
        'validation',
      );
    }
    const snapshot = await world.store.readSnapshot(game.gameId);
    expect(snapshot!.weekRecords.find((r) => r.role === 'factory')?.decision).toBeNull();
    const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
    expect(entries.some((e) => e.kind === 'proxyInput')).toBe(false);
  });

  it('BR11.1 当週でない、準備中は 409 state', async () => {
    const world = createWorld();
    const preparing = await world.createGame();
    await expectProblem(
      world.session.submitDecision(
        preparing.facilitator,
        preparing.gameId,
        1,
        'factory',
        { quantity: 1 },
        newKey(),
      ),
      'state',
    );
    const game = await world.startedGame();
    await expectProblem(
      world.session.submitDecision(
        game.facilitator,
        game.gameId,
        2,
        'factory',
        { quantity: 1 },
        newKey(),
      ),
      'state',
    );
  });

  it('BR11.4 同じ識別子の再送は前回と同じ結果で履歴を二重に残さない。内容が違えば conflict。参加者の記録と混ざらない', async () => {
    const world = createWorld();
    const game = await world.startedGame();
    const key = newKey();
    const first = await world.session.submitDecision(
      game.facilitator,
      game.gameId,
      1,
      'factory',
      { quantity: 8 },
      key,
    );
    const again = await world.session.submitDecision(
      game.facilitator,
      game.gameId,
      1,
      'factory',
      { quantity: 8 },
      key,
    );
    expect(again).toEqual(first);
    const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
    expect(entries.filter((e) => e.kind === 'proxyInput')).toHaveLength(1);
    await expectProblem(
      world.session.submitDecision(
        game.facilitator,
        game.gameId,
        1,
        'factory',
        { quantity: 9 },
        key,
      ),
      'conflict',
    );
    // 同じ識別子の文字列でも、参加者の記録とは別
    const participantResult = await world.session.submitDecision(
      game.players.factory.principal,
      game.gameId,
      1,
      'factory',
      { quantity: 3 },
      key,
    );
    expect(participantResult.quantity).toBe(3);
  });

  it('BR11.4 一時停止中・終了後でも、以前に成功した代理入力の識別子の再送は前回の結果を返す', async () => {
    const world = createWorld();
    const game = await world.startedGame();
    const key = newKey();
    const first = await world.session.submitDecision(
      game.facilitator,
      game.gameId,
      1,
      'factory',
      { quantity: 8 },
      key,
    );
    await world.session.pauseGame(game.facilitator, game.gameId);
    await expect(
      world.session.submitDecision(
        game.facilitator,
        game.gameId,
        1,
        'factory',
        { quantity: 8 },
        key,
      ),
    ).resolves.toEqual(first);
    await world.session.endGame(game.facilitator, game.gameId);
    await expect(
      world.session.submitDecision(
        game.facilitator,
        game.gameId,
        1,
        'factory',
        { quantity: 8 },
        key,
      ),
    ).resolves.toEqual(first);
  });

  it('他のゲームの進行役、別の役割の参加者は代理入力できない（403）', async () => {
    const world = createWorld();
    const game = await world.startedGame();
    const other = await world.createGame();
    await expectProblem(
      world.session.submitDecision(
        other.facilitator,
        game.gameId,
        1,
        'factory',
        { quantity: 1 },
        newKey(),
      ),
      'forbidden',
    );
    await expectProblem(
      world.session.submitDecision(
        game.players.retailer.principal,
        game.gameId,
        1,
        'factory',
        { quantity: 1 },
        newKey(),
      ),
      'forbidden',
    );
  });
});

describe('共同担当（US2.2）', () => {
  it('AC2.2.1 Given 小売店に 2 人 / When A が 8、続けて B が 10 を入力する / Then decision は 10 で、入力者は B、A の画面は異なる版と B のラベルを受け取る', async () => {
    const world = createWorld();
    const { game, a, b } = await sharedRetailerGame(world);
    await world.session.submitDecision(
      a.principal,
      game.gameId,
      1,
      'retailer',
      { quantity: 8 },
      newKey(),
    );
    const seenByA = await world.session.getState(a.principal, game.gameId);
    expect(seenByA.mine).toMatchObject({ decision: 8, decisionRevision: 1 });
    await world.session.submitDecision(
      b.principal,
      game.gameId,
      1,
      'retailer',
      { quantity: 10 },
      newKey(),
    );

    const snapshot = await world.store.readSnapshot(game.gameId);
    expect(snapshot!.weekRecords.find((r) => r.week === 1 && r.role === 'retailer')).toMatchObject({
      decision: 10,
      decidedByParticipantId: b.participantId,
      decisionRevision: 2,
    });
    const nextForA = await world.session.getState(a.principal, game.gameId);
    expect(nextForA.mine).toMatchObject({
      decision: 10,
      decisionRevision: 2,
      decidedBy: { kind: 'participant', label: '次郎 #5', participantId: b.participantId },
    });
  });

  it('BR12.2 他の役割の参加者の投影には、この役割の入力者を含めない', async () => {
    const world = createWorld();
    const { game, a, b, players } = await sharedRetailerGame(world);
    await world.session.submitDecision(
      b.principal,
      game.gameId,
      1,
      'retailer',
      { quantity: 10 },
      newKey(),
    );
    const factoryView = await world.session.getState(players.factory.principal, game.gameId);
    expect(factoryView.role).toBe('factory');
    expect(factoryView.mine?.decidedBy).toBeNull();
    expect(JSON.stringify(factoryView)).not.toContain('次郎 #5 ');
    expect(JSON.stringify(factoryView.mine)).not.toContain(a.participantId);
    expect(JSON.stringify(factoryView.mine)).not.toContain(b.participantId);
  });

  it('BR12.1 同じ値を保存し直しても版は増える（置き換わりの検出は版で行う）', async () => {
    const world = createWorld();
    const game = await world.startedGame();
    const principal = game.players.retailer.principal;
    for (let i = 0; i < 3; i += 1) {
      await world.session.submitDecision(
        principal,
        game.gameId,
        1,
        'retailer',
        { quantity: 4 },
        newKey(),
      );
    }
    const view = await world.session.getState(principal, game.gameId);
    expect(view.mine?.decisionRevision).toBe(3);
  });

  it('AC2.2.2 Given 1 つの役割に 4 人 / When 5 人目を割り当てる / Then 拒否され、割当ては変わらない（BR12.3）', async () => {
    const world = createWorld();
    const game = await world.createGame();
    const people = [];
    for (let i = 1; i <= 5; i += 1) {
      people.push(await world.joinOne(game.joinCode, `参加者${i}`));
    }
    for (const person of people.slice(0, 4)) {
      await world.session.assignRole(
        game.facilitator,
        game.gameId,
        person.participantId,
        'retailer',
      );
    }
    const error = await expectProblem(
      world.session.assignRole(game.facilitator, game.gameId, people[4]!.participantId, 'retailer'),
      'state',
    );
    expect(error.problem.reason).toContain('4 人');
    const snapshot = await world.store.readSnapshot(game.gameId);
    expect(snapshot!.assignments.filter((a) => a.role === 'retailer')).toHaveLength(4);
  });

  it('BR12.3 入れ替えは人数を変えない（4 人の役割で入れ替えても 4 人）', async () => {
    const world = createWorld();
    const game = await world.createGame();
    const people = [];
    for (let i = 1; i <= 4; i += 1) {
      people.push(await world.joinOne(game.joinCode, `参加者${i}`));
    }
    for (const person of people) {
      await world.session.assignRole(
        game.facilitator,
        game.gameId,
        person.participantId,
        'retailer',
      );
    }
    for (const role of ['factory', 'wholesaler1', 'wholesaler2'] as const) {
      const person = await world.joinOne(game.joinCode, role);
      await world.session.assignRole(game.facilitator, game.gameId, person.participantId, role);
    }
    await world.session.startGame(game.facilitator, game.gameId);
    await world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', {
      participantId: people[0]!.participantId,
      displayName: '新人',
    });
    const snapshot = await world.store.readSnapshot(game.gameId);
    expect(snapshot!.assignments.filter((a) => a.role === 'retailer')).toHaveLength(4);
  });
});

describe('同名の参加者の区別（US2.3）', () => {
  it('AC2.3.1 Given 「太郎」がいる / When 別の人が「太郎」で参加する / Then 2 人とも参加でき、ラベルは「太郎 #1」「太郎 #2」で区別され、既存のラベルは変わらない', async () => {
    const world = createWorld();
    const game = await world.createGame();
    const first = await world.joinOne(game.joinCode, '太郎');
    const before = await world.session.getState(first.principal, game.gameId);
    expect(before.participants.map((p) => p.label)).toEqual(['太郎 #1']);
    const second = await world.joinOne(game.joinCode, '太郎');
    expect(second.participantId).not.toBe(first.participantId);
    const after = await world.session.getState(first.principal, game.gameId);
    expect(after.participants.map((p) => p.label)).toEqual(['太郎 #1', '太郎 #2']);
    const facilitatorView = await world.session.getState(game.facilitator, game.gameId);
    expect(facilitatorView.participants.map((p) => p.label)).toEqual(['太郎 #1', '太郎 #2']);
  });

  it('BR12.4 進行管理の担当者の一覧は、ラベルと役割を持つ', async () => {
    const world = createWorld();
    const game = await world.startedGame();
    const view = await world.session.getState(game.facilitator, game.gameId);
    expect(view.assignees).toEqual([
      { participantId: game.players.factory.participantId, label: '工場 #1', role: 'factory' },
      {
        participantId: game.players.wholesaler1.participantId,
        label: '一次卸 #2',
        role: 'wholesaler1',
      },
      {
        participantId: game.players.wholesaler2.participantId,
        label: '二次卸 #3',
        role: 'wholesaler2',
      },
      { participantId: game.players.retailer.participantId, label: '小売店 #4', role: 'retailer' },
    ]);
  });
});
