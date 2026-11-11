import { beforeEach, describe, expect, it } from 'vitest';
import {
  createApplication,
  type Application,
} from '../../src/application/index.js';
import {
  DecisionConflict,
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
  memoryReviewReader,
  memoryUnitOfWork,
  sequentialIds,
} from '../support/memory.js';

let mem: ReturnType<typeof memoryUnitOfWork>;
let app: Application;
const START = new Date('2026-11-10T00:00:00Z');
let now: Date;
/** 時計を進める（資格の期限の境界のテスト） */
const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

beforeEach(() => {
  mem = memoryUnitOfWork();
  now = START;
  app = createApplication({
    uow: mem.uow,
    clock: { now: () => now },
    ids: sequentialIds(),
    credentials: fakeCredentials(),
    reviews: memoryReviewReader(mem),
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
  facilitatorCodes.set(created.gameId, created.recoveryCode);
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

const DAY = 24 * 60 * 60 * 1000;
/** ゲームごとの進行役の復帰コード（作成の応答から記録する） */
const facilitatorCodes = new Map<string, string>();

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
    // 進行役・参加者のそれぞれに、ブラウザセッションと復帰コード
    expect(mem.snapshot().credentials.size).toBe(4);
    const stored = [...mem.snapshot().credentials.keys()];
    expect(stored).not.toContain(j.token);
    expect(stored).not.toContain(j.recoveryCode);
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
    expect(lobby.assignments).toEqual({ FACTORY: [j.participantId] });
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
        'coHolders',
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
    expect(v.decision).toEqual({
      quantity: 6,
      version: 1,
      savedBy: 'P-RETAILER',
    });
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

describe('振り返り（終了後だけ開示）', () => {
  async function playWeek(t: Table, week: number, key: string) {
    for (const role of ROLES) {
      await app.saveDecision({
        token: t.players[role].token,
        gameId: t.gameId,
        role,
        quantity: 4 + week,
        expectedVersion: 0,
      });
    }
    const c = await app.console({ token: t.facilitator, gameId: t.gameId });
    await app.commitWeek({
      token: t.facilitator,
      gameId: t.gameId,
      week,
      version: c.sessionVersion,
      idempotencyKey: key,
    });
  }

  it('[US4.2/AC4.2.2] 進行中は、役割別の値を開示しない（権限エラー）', async () => {
    const t = await setUpTable(2);
    await playWeek(t, 1, 'k1');
    for (const token of [t.facilitator, t.players.RETAILER.token]) {
      const attempt = app.review({ token, gameId: t.gameId });
      await expect(attempt).rejects.toBeInstanceOf(PermissionError);
      await expect(attempt).rejects.toThrow(/終了/);
    }
  });

  it('[US4.2/AC4.2.2] 開始前も開示しない', async () => {
    const t = await setUpTable(2, false);
    await expect(
      app.review({ token: t.facilitator, gameId: t.gameId }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it('[US4.2/AC4.2.1] 終了後は、進行役にも参加者にも、役割別の時系列を返す', async () => {
    const t = await setUpTable(2);
    await playWeek(t, 1, 'k1');
    await playWeek(t, 2, 'k2');
    for (const token of [t.facilitator, t.players.WHOLESALER.token]) {
      const review = await app.review({ token, gameId: t.gameId });
      expect(review.weeks).toEqual([1, 2]);
      expect(review.demand).toEqual([4, 4]);
      expect(review.series.order.RETAILER).toEqual([5, 6]);
      expect(Object.keys(review.series.order)).toEqual([...ROLES]);
    }
  });

  it('[US4.2/AC4.2.2] 資格が無ければ 401 相当、他のゲームの資格は 403 相当', async () => {
    const a = await setUpTable(1);
    const b = await setUpTable(1);
    await expect(
      app.review({ token: 'x', gameId: a.gameId }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      app.review({ token: b.facilitator, gameId: a.gameId }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('[US4.2/AC4.2.3] 終了済みで 0 件なら、空の振り返りを返す（エラーではない）', async () => {
    const t = await setUpTable(1);
    const emptyApp = createApplication({
      uow: mem.uow,
      clock: { now: () => now },
      ids: sequentialIds(),
      credentials: fakeCredentials(),
      reviews: { read: async () => ({ sessionStatus: 'ENDED', rows: [] }) },
    });
    const review = await emptyApp.review({
      token: t.facilitator,
      gameId: t.gameId,
    });
    expect(review.weeks).toEqual([]);
  });
});

describe('停止・再開・代理入力', () => {
  it('[US3.1/AC3.1.1] 停止中は参加者の保存を拒否し、保存済みの入力は残る', async () => {
    const t = await setUpTable();
    await app.saveDecision({
      token: t.players.RETAILER.token,
      gameId: t.gameId,
      role: 'RETAILER',
      quantity: 6,
      expectedVersion: 0,
    });
    await app.pauseSession({ token: t.facilitator, gameId: t.gameId });
    await expect(
      app.saveDecision({
        token: t.players.RETAILER.token,
        gameId: t.gameId,
        role: 'RETAILER',
        quantity: 9,
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/停止中/);
    const me = await app.roleState({
      token: t.players.RETAILER.token,
      gameId: t.gameId,
    });
    expect(me.status).toBe('PAUSED');
    expect(me.decision).toMatchObject({ quantity: 6, version: 1 });
  });

  it('[US3.1/AC3.1.2] 代理入力すると、操作者・役割・時刻・値がイベント（監査の記録）に残る', async () => {
    const t = await setUpTable();
    await app.pauseSession({ token: t.facilitator, gameId: t.gameId });
    const saved = await app.proxyDecision({
      token: t.facilitator,
      gameId: t.gameId,
      role: 'WHOLESALER',
      quantity: 7,
      expectedVersion: 0,
    });
    expect(saved.version).toBe(1);
    const proxy = mem
      .snapshot()
      .events.map((e) => e.event)
      .find((e) => (e as { type: string }).type === 'ProxyDecisionSubmitted');
    expect(proxy).toMatchObject({
      role: 'WHOLESALER',
      quantity: 7,
      operator: 'FACILITATOR',
      at: START.toISOString(),
    });
  });

  it('[US3.1/AC3.1.3] 停止 → 代理入力 → 再開で、最後の確定済みの週から続けて確定できる', async () => {
    const t = await setUpTable();
    for (const role of ROLES.filter((r) => r !== 'FACTORY')) {
      await app.saveDecision({
        token: t.players[role].token,
        gameId: t.gameId,
        role,
        quantity: 4,
        expectedVersion: 0,
      });
    }
    await app.pauseSession({ token: t.facilitator, gameId: t.gameId });
    await app.proxyDecision({
      token: t.facilitator,
      gameId: t.gameId,
      role: 'FACTORY',
      quantity: 5,
      expectedVersion: 0,
    });
    await app.resumeSession({ token: t.facilitator, gameId: t.gameId });
    const c = await app.console({ token: t.facilitator, gameId: t.gameId });
    expect(c.status).toBe('ACTIVE');
    expect(c.versions.FACTORY).toBe(1);
    const result = await app.commitWeek({
      token: t.facilitator,
      gameId: t.gameId,
      week: 1,
      version: c.sessionVersion,
      idempotencyKey: 'k1',
    });
    expect(result).toMatchObject({ committedWeek: 1, nextWeek: 2 });
  });

  it('参加者は、停止・再開・代理入力ができない', async () => {
    const t = await setUpTable();
    const player = { token: t.players.RETAILER.token, gameId: t.gameId };
    await expect(app.pauseSession(player)).rejects.toThrow(PermissionError);
    await expect(app.resumeSession(player)).rejects.toThrow(PermissionError);
    await expect(
      app.proxyDecision({
        ...player,
        role: 'FACTORY',
        quantity: 1,
        expectedVersion: 0,
      }),
    ).rejects.toThrow(PermissionError);
  });
});

describe('復帰（復帰コード）', () => {
  it('[US3.2/AC3.2.1] 参加者が復帰コードで戻ると、新しい資格で同じゲームと役割の最新の状態を見られる', async () => {
    const created = await app.createGame({ weeks: 3 });
    const codes = {} as Record<Role, string>;
    for (const role of ROLES) {
      const j = await app.joinGame({
        joinCode: created.joinCode,
        displayName: role,
      });
      codes[role] = j.recoveryCode;
      await app.assignRole({
        token: created.facilitatorToken,
        gameId: created.gameId,
        participantId: j.participantId,
        role,
      });
    }
    await app.startGame({
      token: created.facilitatorToken,
      gameId: created.gameId,
    });
    const back = await app.recover({ code: codes.WHOLESALER });
    expect(back).toMatchObject({
      gameId: created.gameId,
      kind: 'PARTICIPANT',
      gameStatus: 'STARTED',
    });
    const me = await app.roleState({ token: back.token, gameId: back.gameId });
    expect(me.role).toBe('WHOLESALER');
    expect(
      mem
        .snapshot()
        .events.some(
          (e) =>
            (e.event as { type: string }).type === 'ParticipationRecovered',
        ),
    ).toBe(true);
  });

  it('[US3.2/AC3.2.4] 進行役が復帰コードで戻ると、同じゲームの進行コンソールを開ける', async () => {
    const t = await setUpTable();
    const code = facilitatorCodes.get(t.gameId)!;
    const back = await app.recover({ code });
    expect(back).toMatchObject({ gameId: t.gameId, kind: 'FACILITATOR' });
    const c = await app.console({ token: back.token, gameId: t.gameId });
    expect(c.week).toBe(1);
  });

  it('[US3.2/AC3.2.2] 無効な復帰コードでは復帰せず、進行役への確認を促す', async () => {
    await expect(app.recover({ code: 'no-such-code' })).rejects.toThrow(
      UnauthorizedError,
    );
    await expect(app.recover({ code: '' })).rejects.toThrow(/進行役/);
  });

  it('[US3.2/AC3.2.2] 削除済み（ゲームが無い）の復帰コードでは復帰しない', async () => {
    const c = await app.createGame({ weeks: 3 });
    const j = await app.joinGame({ joinCode: c.joinCode, displayName: '花子' });
    mem.snapshot().games.delete(c.gameId);
    await expect(app.recover({ code: j.recoveryCode })).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it('[US3.2/AC3.2.5] 復帰コードは 30 日で期限切れになる（境界）', async () => {
    const c = await app.createGame({ weeks: 3 });
    const j = await app.joinGame({ joinCode: c.joinCode, displayName: '花子' });
    advance(30 * DAY - 1);
    await expect(app.recover({ code: j.recoveryCode })).resolves.toMatchObject({
      kind: 'PARTICIPANT',
    });
    advance(1);
    await expect(app.recover({ code: j.recoveryCode })).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it('[US3.2/AC3.2.5] ブラウザセッションは 24 時間で期限切れになる（境界）', async () => {
    const c = await app.createGame({ weeks: 3 });
    const lobby = { token: c.facilitatorToken, gameId: c.gameId };
    advance(DAY - 1);
    await expect(app.lobby(lobby)).resolves.toBeDefined();
    advance(1);
    await expect(app.lobby(lobby)).rejects.toThrow(UnauthorizedError);
  });
});

describe('資格の失効と再発行', () => {
  it('[US3.2/AC3.2.5] 進行役が参加者の資格を再発行すると、古いブラウザセッションと古い復帰コードは使えない', async () => {
    const c = await app.createGame({ weeks: 3 });
    const j = await app.joinGame({ joinCode: c.joinCode, displayName: '花子' });
    const reissued = await app.reissueCredential({
      token: c.facilitatorToken,
      gameId: c.gameId,
      target: { kind: 'PARTICIPANT', participantId: j.participantId },
    });
    await expect(
      app.lobby({ token: j.token, gameId: c.gameId }),
    ).rejects.toThrow(UnauthorizedError);
    await expect(app.recover({ code: j.recoveryCode })).rejects.toThrow(
      UnauthorizedError,
    );
    const back = await app.recover({ code: reissued.recoveryCode });
    expect(back).toMatchObject({
      kind: 'PARTICIPANT',
      participantId: j.participantId,
    });
    // 進行役自身の資格は影響を受けない
    await expect(
      app.lobby({ token: c.facilitatorToken, gameId: c.gameId }),
    ).resolves.toBeDefined();
    const types = mem
      .snapshot()
      .events.map((e) => (e.event as { type: string }).type);
    expect(types).toEqual(
      expect.arrayContaining(['CredentialRevoked', 'CredentialReissued']),
    );
  });

  it('[US3.2/AC3.2.5] 進行役が自分の資格を再発行すると、古い資格は使えず、新しい資格と復帰コードが返る', async () => {
    const c = await app.createGame({ weeks: 3 });
    const old = c.recoveryCode;
    const reissued = await app.reissueCredential({
      token: c.facilitatorToken,
      gameId: c.gameId,
      target: { kind: 'FACILITATOR' },
    });
    expect(reissued.facilitatorToken).toBeDefined();
    await expect(
      app.lobby({ token: c.facilitatorToken, gameId: c.gameId }),
    ).rejects.toThrow(UnauthorizedError);
    await expect(app.recover({ code: old })).rejects.toThrow(UnauthorizedError);
    await expect(
      app.lobby({ token: reissued.facilitatorToken!, gameId: c.gameId }),
    ).resolves.toMatchObject({ viewer: { kind: 'FACILITATOR' } });
    await expect(
      app.recover({ code: reissued.recoveryCode }),
    ).resolves.toMatchObject({ kind: 'FACILITATOR' });
  });

  it('参加者は再発行できない。他のゲームの参加者は対象にできない', async () => {
    const c = await app.createGame({ weeks: 3 });
    const j = await app.joinGame({ joinCode: c.joinCode, displayName: '花子' });
    await expect(
      app.reissueCredential({
        token: j.token,
        gameId: c.gameId,
        target: { kind: 'FACILITATOR' },
      }),
    ).rejects.toThrow(PermissionError);
    const other = await app.createGame({ weeks: 3 });
    const stranger = await app.joinGame({
      joinCode: other.joinCode,
      displayName: '太郎',
    });
    await expect(
      app.reissueCredential({
        token: c.facilitatorToken,
        gameId: c.gameId,
        target: { kind: 'PARTICIPANT', participantId: stranger.participantId },
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('共同担当と共同入力', () => {
  /** 小売店に 2 人（花子・太郎）を割り当てて開始する */
  async function coTable() {
    const created = await app.createGame({ weeks: 3 });
    const tokens: Record<string, string> = {};
    for (const role of ROLES) {
      const j = await app.joinGame({
        joinCode: created.joinCode,
        displayName: `P-${role}`,
      });
      await app.assignRole({
        token: created.facilitatorToken,
        gameId: created.gameId,
        participantId: j.participantId,
        role,
      });
      tokens[role] = j.token;
    }
    const taro = await app.joinGame({
      joinCode: created.joinCode,
      displayName: '太郎',
    });
    await app.assignRole({
      token: created.facilitatorToken,
      gameId: created.gameId,
      participantId: taro.participantId,
      role: 'RETAILER',
    });
    await app.startGame({
      token: created.facilitatorToken,
      gameId: created.gameId,
    });
    return {
      gameId: created.gameId,
      facilitator: created.facilitatorToken,
      hanako: tokens.RETAILER!,
      taro: taro.token,
    };
  }

  it('[US1.2/AC1.2.4] ロビーは、役割ごとに担当の一覧を示す', async () => {
    const t = await coTable();
    const lobby = await app.lobby({ token: t.facilitator, gameId: t.gameId });
    expect(lobby.assignments.RETAILER).toHaveLength(2);
    expect(lobby.missingRoles).toEqual([]);
  });

  it('[US2.1/AC2.1.4] 共同担当は、同じ状況と、入力値・版・保存者・担当の一覧を見る', async () => {
    const t = await coTable();
    await app.saveDecision({
      token: t.taro,
      gameId: t.gameId,
      role: 'RETAILER',
      quantity: 8,
      expectedVersion: 0,
    });
    const a = await app.roleState({ token: t.hanako, gameId: t.gameId });
    const b = await app.roleState({ token: t.taro, gameId: t.gameId });
    expect(a).toEqual(b);
    expect(a.role).toBe('RETAILER');
    expect(a.decision).toEqual({ quantity: 8, version: 1, savedBy: '太郎' });
    expect(a.coHolders).toEqual(['P-RETAILER', '太郎']);
  });

  it('[US2.2/AC2.2.4] 一人が保存すると、もう一人は同じ版から上書きでき、版が進む', async () => {
    const t = await coTable();
    await app.saveDecision({
      token: t.hanako,
      gameId: t.gameId,
      role: 'RETAILER',
      quantity: 6,
      expectedVersion: 0,
    });
    const saved = await app.saveDecision({
      token: t.taro,
      gameId: t.gameId,
      role: 'RETAILER',
      quantity: 7,
      expectedVersion: 1,
    });
    expect(saved.version).toBe(2);
  });

  it('[US2.2/AC2.2.3] 同じ版から後で保存すると、最新の値・版・保存者の表示名を持つ競合になり、先の保存は残る', async () => {
    const t = await coTable();
    await app.saveDecision({
      token: t.hanako,
      gameId: t.gameId,
      role: 'RETAILER',
      quantity: 6,
      expectedVersion: 0,
    });
    const late = app.saveDecision({
      token: t.taro,
      gameId: t.gameId,
      role: 'RETAILER',
      quantity: 10,
      expectedVersion: 0,
    });
    await expect(late).rejects.toBeInstanceOf(DecisionConflict);
    await expect(late).rejects.toMatchObject({
      latest: { quantity: 6, version: 1, savedBy: 'P-RETAILER' },
    });
    const state = await app.roleState({ token: t.taro, gameId: t.gameId });
    expect(state.decision?.quantity).toBe(6);
  });

  it('[US2.2/AC2.2.3] 代理入力の後の競合では、保存者を「進行役」と示す', async () => {
    const t = await coTable();
    await app.proxyDecision({
      token: t.facilitator,
      gameId: t.gameId,
      role: 'RETAILER',
      quantity: 3,
      expectedVersion: 0,
    });
    await expect(
      app.saveDecision({
        token: t.hanako,
        gameId: t.gameId,
        role: 'RETAILER',
        quantity: 1,
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ latest: { savedBy: '進行役' } });
  });
});
