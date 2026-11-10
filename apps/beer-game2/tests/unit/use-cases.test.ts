import { beforeEach, describe, expect, it } from 'vitest';
import {
  createApplication,
  type Application,
} from '../../src/application/index.js';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../src/application/errors.js';
import { ROLES, type Role } from '../../src/domain/role.js';
import {
  DomainError,
  PermissionError,
  StaleError,
} from '../../src/domain/values.js';
import { ConflictError } from '../../src/ports/index.js';
import {
  fakeCredentials,
  memoryUnitOfWork,
  sequentialIds,
} from '../support/memory.js';

let mem: ReturnType<typeof memoryUnitOfWork>;
let app: Application;

beforeEach(() => {
  mem = memoryUnitOfWork();
  app = createApplication({
    uow: mem.uow,
    clock: { now: () => new Date('2026-11-10T00:00:00Z') },
    ids: sequentialIds(),
    credentials: fakeCredentials(),
  });
});

interface Table {
  gameId: string;
  facilitator: string;
  players: Record<Role, { token: string; participantId: string }>;
}

async function setUpTable(
  weeks = 3,
  start = true,
  commitMode?: 'AUTO' | 'MANUAL',
): Promise<Table> {
  const created = await app.createGame({ weeks, commitMode });
  const players = {} as Table['players'];
  for (const role of ROLES) {
    const joined = await app.joinGame({
      joinCode: created.joinCode,
      displayName: `P-${role}`,
    });
    await app.assignRole({
      token: created.facilitatorToken,
      gameId: created.gameId,
      participantId: joined.participantId,
      role,
    });
    players[role] = {
      token: joined.token,
      participantId: joined.participantId,
    };
  }
  if (start)
    await app.startGame({
      token: created.facilitatorToken,
      gameId: created.gameId,
    });
  return {
    gameId: created.gameId,
    facilitator: created.facilitatorToken,
    players,
  };
}

async function fillAll(t: Table, quantity = 4) {
  for (const role of ROLES) {
    await app.saveDecision({
      token: t.players[role].token,
      gameId: t.gameId,
      role,
      quantity,
      expectedVersion: 0,
    });
  }
}

describe('作成・参加・割り当て・開始', () => {
  it('[US1.1/AC1.1.1] ゲームを作ると、参加コードと進行役の資格が返り、ロビーを進行役が見られる', async () => {
    const c = await app.createGame({ weeks: 5 });
    expect(c.joinCode).toMatch(/^JOIN-/);
    const lobby = await app.lobby({
      token: c.facilitatorToken,
      gameId: c.gameId,
    });
    expect(lobby).toMatchObject({
      status: 'PREPARING',
      finalWeek: 5,
      joinCode: c.joinCode,
    });
    expect(lobby.missingRoles).toEqual([...ROLES]);
    expect(lobby.viewer).toEqual({ kind: 'FACILITATOR' });
  });

  it('[US1.2/AC1.2.1] 参加者のロビーは、参加コードを含まず、自分の ID を示す', async () => {
    const t = await setUpTable(3, false);
    const lobby = await app.lobby({
      token: t.players.RETAILER.token,
      gameId: t.gameId,
    });
    expect(lobby).not.toHaveProperty('joinCode');
    expect(lobby.viewer).toEqual({
      kind: 'PARTICIPANT',
      participantId: t.players.RETAILER.participantId,
    });
  });

  it('[US1.1/AC1.1.2] 無効な需要系列は、対象週つきで拒否する', async () => {
    await expect(
      app.createGame({ weeks: 3, demand: [4, 4, 5000] }),
    ).rejects.toMatchObject({
      issues: [{ week: 3 }],
    });
  });

  it('[US1.2/AC1.2.1] 参加コードで参加でき、復帰資格が保存される', async () => {
    const c = await app.createGame({ weeks: 3 });
    const j = await app.joinGame({ joinCode: c.joinCode, displayName: '花子' });
    expect(j.gameId).toBe(c.gameId);
    expect(mem.snapshot().credentials.size).toBe(2); // 進行役 + 参加者
    expect([...mem.snapshot().credentials.keys()]).not.toContain(j.token);
  });

  it('[US1.2/AC1.2.2] 存在しないコードでは参加できない', async () => {
    const c = await app.createGame({ weeks: 3 });
    const j = await app.joinGame({ joinCode: c.joinCode, displayName: '花子' });
    expect(j.gameId).toBe(c.gameId);
    await expect(
      app.joinGame({ joinCode: 'NOPE', displayName: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('[US1.2/AC1.2.2] 受付終了後の参加は、理由を示して拒否する', async () => {
    const t = await setUpTable();
    const c = await app.lobby({ token: t.facilitator, gameId: t.gameId });
    await expect(
      app.joinGame({ joinCode: c.joinCode!, displayName: 'late' }),
    ).rejects.toThrow(/受付を終了/);
  });

  it('[US1.2] 参加者は役割を割り当てられない／他のゲームの資格は使えない', async () => {
    const t = await setUpTable(3, false);
    await expect(
      app.assignRole({
        token: t.players.RETAILER.token,
        gameId: t.gameId,
        participantId: t.players.RETAILER.participantId,
        role: 'FACTORY',
      }),
    ).rejects.toBeInstanceOf(PermissionError);
    const other = await setUpTable(3, false);
    await expect(
      app.lobby({ token: other.facilitator, gameId: t.gameId }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      app.lobby({ token: 'unknown', gameId: t.gameId }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('[US1.2/AC1.2.3] 開始すると進行中になり、ロビーは開始済みを示す', async () => {
    const t = await setUpTable();
    const lobby = await app.lobby({ token: t.facilitator, gameId: t.gameId });
    expect(lobby.status).toBe('STARTED');
    expect(mem.snapshot().sessions.get(t.gameId)?.status).toBe('ACTIVE');
  });

  it('[US1.2/AC1.2.5] 1 人に複数の役割は割り当てられず、解除すれば割り当て直せる', async () => {
    const c = await app.createGame({ weeks: 3 });
    const j = await app.joinGame({ joinCode: c.joinCode, displayName: '花子' });
    const base = {
      token: c.facilitatorToken,
      gameId: c.gameId,
      participantId: j.participantId,
    };
    await app.assignRole({ ...base, role: 'RETAILER' });
    await expect(app.assignRole({ ...base, role: 'FACTORY' })).rejects.toThrow(
      /RETAILER/,
    );
    await app.unassignRole(base);
    await app.assignRole({ ...base, role: 'FACTORY' });
    const lobby = await app.lobby({
      token: c.facilitatorToken,
      gameId: c.gameId,
    });
    expect(lobby.assignments).toEqual({ FACTORY: j.participantId });
    expect(lobby.missingRoles).toEqual([
      'DISTRIBUTOR',
      'WHOLESALER',
      'RETAILER',
    ]);
  });

  it('[US1.2/AC1.2.3] 役割が足りないと、開始に失敗し、何も作られない', async () => {
    const c = await app.createGame({ weeks: 3 });
    await expect(
      app.startGame({ token: c.facilitatorToken, gameId: c.gameId }),
    ).rejects.toThrow(DomainError);
    expect(mem.snapshot().sessions.size).toBe(0);
  });
});

describe('役割別の状況（情報の制約）', () => {
  it('[US2.1/AC2.1.3] 小売店以外には、当週・将来の需要が開示されない', async () => {
    const t = await setUpTable();
    const retailer = await app.roleState({
      token: t.players.RETAILER.token,
      gameId: t.gameId,
    });
    expect(retailer).toMatchObject({
      role: 'RETAILER',
      week: 1,
      customerDemand: 4,
      inventory: 12,
    });
    const wholesaler = await app.roleState({
      token: t.players.WHOLESALER.token,
      gameId: t.gameId,
    });
    expect(wholesaler).not.toHaveProperty('customerDemand');
    expect(JSON.stringify(wholesaler)).not.toContain('P-RETAILER');
  });

  it('[US2.1/AC2.1.1] 自分の役割の値だけが含まれる（他の役割・将来の需要は含まれない）', async () => {
    const t = await setUpTable();
    const view = await app.roleState({
      token: t.players.RETAILER.token,
      gameId: t.gameId,
    });
    expect(Object.keys(view).sort()).toEqual(
      [
        'backlog',
        'commitMode',
        'customerDemand',
        'decision',
        'history',
        'incomingGoods',
        'inventory',
        'role',
        'sessionVersion',
        'status',
        'week',
      ].sort(),
    );
  });

  it('[US2.1] 進行役のコンソールは、入力の有無だけを見せる', async () => {
    const t = await setUpTable();
    await app.saveDecision({
      token: t.players.FACTORY.token,
      gameId: t.gameId,
      role: 'FACTORY',
      quantity: 9,
      expectedVersion: 0,
    });
    const c = await app.console({ token: t.facilitator, gameId: t.gameId });
    expect(c.submitted).toEqual({
      FACTORY: true,
      DISTRIBUTOR: false,
      WHOLESALER: false,
      RETAILER: false,
    });
    expect(JSON.stringify(c)).not.toContain('9');
  });
});

describe('自動確定', () => {
  it('[US2.4/AC2.4.1] 自動確定のゲームは、最後の発注の保存で次の週に進み、結果が返る', async () => {
    const t = await setUpTable(3, true, 'AUTO');
    const results = [];
    for (const role of ROLES) {
      results.push(
        await app.saveDecision({
          token: t.players[role].token,
          gameId: t.gameId,
          role,
          quantity: 4,
          expectedVersion: 0,
        }),
      );
    }
    expect(results.slice(0, 3).every((r) => r.committed === undefined)).toBe(
      true,
    );
    expect(results[3]?.committed).toEqual({
      committedWeek: 1,
      nextWeek: 2,
      status: 'ACTIVE',
    });
    const c = await app.console({ token: t.facilitator, gameId: t.gameId });
    expect(c.week).toBe(2);
    expect(
      mem
        .snapshot()
        .events.filter(
          (e) => (e.event as { type: string }).type === 'WeekCommitted',
        ),
    ).toHaveLength(1);
  });

  it('[US2.4] 手動のゲームは、そろっても進まない', async () => {
    const t = await setUpTable(3, true, 'MANUAL');
    await fillAll(t);
    expect(
      (await app.console({ token: t.facilitator, gameId: t.gameId })).week,
    ).toBe(1);
  });
});

describe('意思決定と週の確定', () => {
  it('[US2.2/AC2.2.1] 自分の発注を保存すると、状況に反映される', async () => {
    const t = await setUpTable();
    await app.saveDecision({
      token: t.players.RETAILER.token,
      gameId: t.gameId,
      role: 'RETAILER',
      quantity: 6,
      expectedVersion: 0,
    });
    const v = await app.roleState({
      token: t.players.RETAILER.token,
      gameId: t.gameId,
    });
    expect(v.decision).toEqual({ quantity: 6, version: 1 });
  });

  it('[US2.1/AC2.1.2] 他の役割には、保存できない（権限エラー）', async () => {
    const t = await setUpTable();
    await expect(
      app.saveDecision({
        token: t.players.RETAILER.token,
        gameId: t.gameId,
        role: 'FACTORY',
        quantity: 1,
        expectedVersion: 0,
      }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it('[US2.3/AC2.3.1] 確定すると週が進み、役割別の結果が自分の履歴に載る', async () => {
    const t = await setUpTable();
    await fillAll(t);
    const c = await app.console({ token: t.facilitator, gameId: t.gameId });
    const r = await app.commitWeek({
      token: t.facilitator,
      gameId: t.gameId,
      week: 1,
      version: c.sessionVersion,
      idempotencyKey: 'k1',
    });
    expect(r).toMatchObject({
      committedWeek: 1,
      nextWeek: 2,
      status: 'ACTIVE',
    });
    const v = await app.roleState({
      token: t.players.RETAILER.token,
      gameId: t.gameId,
    });
    expect(v.week).toBe(2);
    expect(v.history).toHaveLength(1);
    expect(v.history[0]).toMatchObject({
      week: 1,
      order: 4,
      endingInventory: 12,
    });
    expect(v.history[0]).not.toHaveProperty('WHOLESALER');
    expect(
      mem
        .snapshot()
        .events.some(
          (e) => (e.event as { type: string }).type === 'WeekCommitted',
        ),
    ).toBe(true);
  });

  it('[US2.3/AC2.3.2] 同じ冪等キーの再実行は同じ結果で、週は二重に進まない', async () => {
    const t = await setUpTable();
    await fillAll(t);
    const c = await app.console({ token: t.facilitator, gameId: t.gameId });
    const req = {
      token: t.facilitator,
      gameId: t.gameId,
      week: 1,
      version: c.sessionVersion,
      idempotencyKey: 'k1',
    };
    const a = await app.commitWeek(req);
    const b = await app.commitWeek(req);
    expect(b).toEqual(a);
    expect(mem.snapshot().sessions.get(t.gameId)?.week).toBe(2);
  });

  it('[US2.3/AC2.3.2] 同じキーで内容が違えば競合、古い版は拒否される', async () => {
    const t = await setUpTable();
    await fillAll(t);
    const c = await app.console({ token: t.facilitator, gameId: t.gameId });
    const base = {
      token: t.facilitator,
      gameId: t.gameId,
      week: 1,
      idempotencyKey: 'k1',
    };
    await app.commitWeek({ ...base, version: c.sessionVersion });
    await expect(
      app.commitWeek({ ...base, version: c.sessionVersion + 5 }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      app.commitWeek({
        ...base,
        idempotencyKey: 'k2',
        version: c.sessionVersion,
      }),
    ).rejects.toBeInstanceOf(StaleError);
  });

  it('[US2.3/AC2.3.3] 保存の途中で失敗しても、部分的な更新は残らない（原子性）', async () => {
    const t = await setUpTable();
    await fillAll(t);
    const before = structuredClone(mem.snapshot().sessions.get(t.gameId));
    const c = await app.console({ token: t.facilitator, gameId: t.gameId });
    mem.failEventAppend(true);
    await expect(
      app.commitWeek({
        token: t.facilitator,
        gameId: t.gameId,
        week: 1,
        version: c.sessionVersion,
        idempotencyKey: 'k9',
      }),
    ).rejects.toThrow('injected failure');
    mem.failEventAppend(false);
    expect(mem.snapshot().sessions.get(t.gameId)).toEqual(before);
    expect(mem.snapshot().idempotency.size).toBe(0);
  });

  it('[US2.3/AC2.3.4] 最終週まで通して確定すると、終了する', async () => {
    const t = await setUpTable(2);
    for (let week = 1; week <= 2; week++) {
      if (week > 1) {
        for (const role of ROLES) {
          await app.saveDecision({
            token: t.players[role].token,
            gameId: t.gameId,
            role,
            quantity: 4,
            expectedVersion: 0,
          });
        }
      } else {
        await fillAll(t);
      }
      const c = await app.console({ token: t.facilitator, gameId: t.gameId });
      await app.commitWeek({
        token: t.facilitator,
        gameId: t.gameId,
        week,
        version: c.sessionVersion,
        idempotencyKey: `k${week}`,
      });
    }
    const c = await app.console({ token: t.facilitator, gameId: t.gameId });
    expect(c.status).toBe('ENDED');
  });
});
