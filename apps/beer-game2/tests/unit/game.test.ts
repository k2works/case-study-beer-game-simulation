import { describe, expect, it } from 'vitest';
import { FACILITATOR, participant } from '../../src/domain/actor.js';
import {
  assignRole,
  unassignRole,
  createGame,
  joinGame,
  kitDemand,
  missingRoles,
  startGame,
  type Game,
} from '../../src/domain/game.js';
import { ROLES } from '../../src/domain/role.js';
import { DomainError, PermissionError } from '../../src/domain/values.js';

const newGame = (weeks = 10): Game =>
  createGame({ id: 'g1', joinCode: 'JOIN-0001', weeks }).game;

function readyGame(): Game {
  let g = newGame();
  ROLES.forEach((role, i) => {
    const id = `p${i}`;
    g = joinGame(g, { participantId: id, displayName: `参加者${i}` }).game;
    g = assignRole(g, FACILITATOR, id, role).game;
  });
  return g;
}

describe('createGame', () => {
  it('[US1.1/AC1.1.1] キット準拠の設定で、準備中のゲームができる', () => {
    const { game, events } = createGame({
      id: 'g1',
      joinCode: 'JOIN-0001',
      weeks: 10,
    });
    expect(game).toMatchObject({
      id: 'g1',
      status: 'PREPARING',
      version: 0,
      settings: {
        kind: 'KIT',
        finalWeek: 10,
        holdingCostMinor: 50,
        backlogCostMinor: 100,
        quantityMax: 1000,
      },
    });
    expect(game.settings.demand).toEqual(kitDemand(10));
    expect(kitDemand(6)).toEqual([4, 4, 4, 4, 8, 8]);
    expect(events).toEqual([
      { type: 'GameCreated', gameId: 'g1', kind: 'KIT' },
    ]);
  });

  it('[US2.4] 確定方式は既定で手動。自動を指定できる', () => {
    expect(
      createGame({ id: 'g1', joinCode: 'J', weeks: 3 }).game.settings
        .commitMode,
    ).toBe('MANUAL');
    const auto = createGame({
      id: 'g1',
      joinCode: 'J',
      weeks: 3,
      commitMode: 'AUTO',
    });
    expect(auto.game.settings.commitMode).toBe('AUTO');
  });

  it.each([0, 51])('[US1.1/AC1.1.2] 週数 %i は拒否する', (weeks) => {
    expect(() =>
      createGame({ id: 'g1', joinCode: 'JOIN-0001', weeks }),
    ).toThrow(DomainError);
  });

  it('[US1.1/AC1.1.2] 無効な需要系列は、対象週と修正内容を示す', () => {
    try {
      createGame({
        id: 'g1',
        joinCode: 'JOIN-0001',
        weeks: 3,
        demand: [4, -2, 4],
      });
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).issues).toEqual([
        {
          week: 2,
          problem: '0〜1000 の整数ではありません',
          fix: '0〜1000 の整数にしてください',
        },
      ]);
    }
  });
});

describe('joinGame', () => {
  it('[US1.2/AC1.2.1] 準備中は参加でき、役割は未割り当て', () => {
    const { game, events } = joinGame(newGame(), {
      participantId: 'p1',
      displayName: ' 花子 ',
    });
    expect(game.participants).toEqual([{ id: 'p1', displayName: '花子' }]);
    expect(game.assignments).toEqual({});
    expect(events).toEqual([
      { type: 'ParticipantJoined', gameId: 'g1', participantId: 'p1' },
    ]);
  });

  it('[US1.2/AC1.2.2] 受付終了後（開始済み）の参加は拒否し、理由を示す', () => {
    const started = startGame(readyGame(), FACILITATOR).game;
    expect(() =>
      joinGame(started, { participantId: 'x', displayName: 'x' }),
    ).toThrow(/受付を終了/);
  });

  it('同じ参加者 ID の二重参加は拒否する', () => {
    const g = joinGame(newGame(), {
      participantId: 'p1',
      displayName: 'a',
    }).game;
    expect(() =>
      joinGame(g, { participantId: 'p1', displayName: 'a' }),
    ).toThrow(DomainError);
  });
});

describe('assignRole', () => {
  const withP = () =>
    joinGame(newGame(), { participantId: 'p1', displayName: 'a' }).game;

  it('[US1.2/AC1.2.2] 進行役が役割を割り当てる', () => {
    const { game, events } = assignRole(withP(), FACILITATOR, 'p1', 'RETAILER');
    expect(game.assignments).toEqual({ RETAILER: 'p1' });
    expect(events).toEqual([
      {
        type: 'RoleAssigned',
        gameId: 'g1',
        participantId: 'p1',
        role: 'RETAILER',
      },
    ]);
  });

  it('[US1.2] 進行役以外は割り当てられない（権限エラー）', () => {
    expect(() =>
      assignRole(withP(), participant('p1'), 'p1', 'RETAILER'),
    ).toThrow(PermissionError);
  });

  it('[US1.2/AC1.2.5] 1 人に複数の役割は割り当てられない。現在の役割を示す', () => {
    const g = assignRole(withP(), FACILITATOR, 'p1', 'RETAILER').game;
    expect(() => assignRole(g, FACILITATOR, 'p1', 'FACTORY')).toThrow(
      /RETAILER/,
    );
    expect(g.assignments).toEqual({ RETAILER: 'p1' });
  });

  it('[US1.2] 割り当てを解除すると、別の役割に割り当て直せる', () => {
    const assigned = assignRole(withP(), FACILITATOR, 'p1', 'RETAILER').game;
    const out = unassignRole(assigned, FACILITATOR, 'p1');
    expect(out.game.assignments).toEqual({});
    expect(out.events).toEqual([
      { type: 'RoleUnassigned', gameId: 'g1', participantId: 'p1' },
    ]);
    const g = assignRole(out.game, FACILITATOR, 'p1', 'FACTORY').game;
    expect(g.assignments).toEqual({ FACTORY: 'p1' });
    expect(() => unassignRole(withP(), participant('p1'), 'p1')).toThrow(
      PermissionError,
    );
  });

  it('[US1.2] この Bolt では 1 役割 1 人。埋まっている役割は拒否する', () => {
    let g = joinGame(withP(), { participantId: 'p2', displayName: 'b' }).game;
    g = assignRole(g, FACILITATOR, 'p1', 'RETAILER').game;
    expect(() => assignRole(g, FACILITATOR, 'p2', 'RETAILER')).toThrow(
      /割り当て済み/,
    );
  });

  it('未参加の参加者は割り当てられない', () => {
    expect(() => assignRole(withP(), FACILITATOR, 'zzz', 'RETAILER')).toThrow(
      DomainError,
    );
  });
});

describe('startGame', () => {
  it('[US1.2/AC1.2.3] 4 役割がそろっていれば開始でき、設定が固定される', () => {
    const { game, events } = startGame(readyGame(), FACILITATOR);
    expect(game.status).toBe('STARTED');
    expect(game.version).toBeGreaterThan(0);
    expect(events).toEqual([{ type: 'GameStarted', gameId: 'g1' }]);
    expect(() => assignRole(game, FACILITATOR, 'p0', 'RETAILER')).toThrow(
      /受付を終了/,
    );
  });

  it('[US1.2/AC1.2.3] 足りない役割を示して拒否する', () => {
    let g = joinGame(newGame(), { participantId: 'p1', displayName: 'a' }).game;
    g = assignRole(g, FACILITATOR, 'p1', 'FACTORY').game;
    expect(missingRoles(g)).toEqual(['DISTRIBUTOR', 'WHOLESALER', 'RETAILER']);
    try {
      startGame(g, FACILITATOR);
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).issues.map((i) => i.problem)).toEqual([
        'DISTRIBUTOR に参加者がいません',
        'WHOLESALER に参加者がいません',
        'RETAILER に参加者がいません',
      ]);
    }
  });

  it('進行役以外は開始できない（権限エラー）', () => {
    expect(() => startGame(readyGame(), participant('p0'))).toThrow(
      PermissionError,
    );
  });

  it('二重の開始は拒否する', () => {
    const g = startGame(readyGame(), FACILITATOR).game;
    expect(() => startGame(g, FACILITATOR)).toThrow(DomainError);
  });
});
