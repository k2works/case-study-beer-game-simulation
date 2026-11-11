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
import { ExportIncompleteError } from '../../src/domain/export.js';
import { ConflictError } from '../../src/ports/index.js';
import {
  fakeCredentials,
  memoryExportReader,
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
    exports: memoryExportReader(mem),
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
    // 入力値（9）を含まない（保持方針の日付と条件の値は、入力値と無関係なので除く）
    expect(
      JSON.stringify({
        submitted: c.submitted,
        versions: c.versions,
        week: c.week,
        status: c.status,
      }),
    ).not.toContain('9');
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
      exports: memoryExportReader(mem),
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

describe('カスタム条件', () => {
  it('[US1.1/AC1.1.3] カスタム条件で作ると、ロビーと進行役のコンソールに「カスタム」と変更項目、条件の値が出る', async () => {
    const created = await app.createGame({
      weeks: 3,
      conditions: { initialInventory: 20, holdingCostMinor: 25 },
    });
    const lobby = await app.lobby({
      token: created.facilitatorToken,
      gameId: created.gameId,
    });
    expect(lobby.settings).toEqual({
      kind: 'CUSTOM',
      changes: ['initialInventory', 'holdingCostMinor'],
      initialInventory: 20,
      orderDelayWeeks: 2,
      shipmentDelayWeeks: 2,
      productionDelayWeeks: 2,
      holdingCostMinor: 25,
      backlogCostMinor: 100,
      disclosure: 'TEAM_TOTAL',
    });
  });

  it('[US1.1/AC1.1.3] 参加者のロビーにも、準拠かカスタムかが出る', async () => {
    const c = await app.createGame({ weeks: 3 });
    const j = await app.joinGame({ joinCode: c.joinCode, displayName: '花子' });
    const lobby = await app.lobby({ token: j.token, gameId: c.gameId });
    expect(lobby.settings).toMatchObject({ kind: 'KIT', changes: [] });
  });

  it('[US1.1/AC1.1.4] 範囲外の条件では、作成せず、何も残らない', async () => {
    await expect(
      app.createGame({ weeks: 3, conditions: { orderDelayWeeks: 0 } }),
    ).rejects.toThrow(DomainError);
    expect(mem.snapshot().games.size).toBe(0);
  });

  it('[US1.1/AC1.1.4] 条件の初期在庫で始まり、進行役のコンソールにも種別が出る', async () => {
    const created = await app.createGame({
      weeks: 3,
      conditions: { initialInventory: 40 },
    });
    const ids: string[] = [];
    for (const role of ROLES) {
      const j = await app.joinGame({
        joinCode: created.joinCode,
        displayName: role,
      });
      ids.push(j.token);
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
    const me = await app.roleState({ token: ids[3]!, gameId: created.gameId });
    expect(me.inventory).toBe(40);
    const c = await app.console({
      token: created.facilitatorToken,
      gameId: created.gameId,
    });
    expect(c.settings).toMatchObject({
      kind: 'CUSTOM',
      changes: ['initialInventory'],
    });
  });
});

describe('確定方式の変更', () => {
  it('[US2.4/AC2.4.5] 進行役は進行中に自動確定を無効にでき、コンソールと参加者の画面に反映される', async () => {
    const t = await setUpTable(3, true, 'AUTO');
    await app.changeCommitMode({
      token: t.facilitator,
      gameId: t.gameId,
      commitMode: 'MANUAL',
    });
    const c = await app.console({ token: t.facilitator, gameId: t.gameId });
    expect(c.commitMode).toBe('MANUAL');
    const me = await app.roleState({
      token: t.players.RETAILER.token,
      gameId: t.gameId,
    });
    expect(me.commitMode).toBe('MANUAL');
    await fillAll(t);
    const after = await app.console({ token: t.facilitator, gameId: t.gameId });
    expect(after.week).toBe(1);
  });

  it('[US2.4/AC2.4.3] 自動確定のゲームで、停止中に代理入力でそろえ、再開すると確定する', async () => {
    const t = await setUpTable(3, true, 'AUTO');
    await app.pauseSession({ token: t.facilitator, gameId: t.gameId });
    for (const role of ROLES)
      await app.proxyDecision({
        token: t.facilitator,
        gameId: t.gameId,
        role,
        quantity: 4,
        expectedVersion: 0,
      });
    expect(
      (await app.console({ token: t.facilitator, gameId: t.gameId })).week,
    ).toBe(1);
    await app.resumeSession({ token: t.facilitator, gameId: t.gameId });
    expect(
      (await app.console({ token: t.facilitator, gameId: t.gameId })).week,
    ).toBe(2);
  });

  it('参加者は確定方式を変えられない', async () => {
    const t = await setUpTable(3, true, 'AUTO');
    await expect(
      app.changeCommitMode({
        token: t.players.RETAILER.token,
        gameId: t.gameId,
        commitMode: 'MANUAL',
      }),
    ).rejects.toThrow(PermissionError);
  });
});

describe('観察者', () => {
  async function invite(t: Table) {
    return app.issueObserverInvitation({
      token: t.facilitator,
      gameId: t.gameId,
    });
  }
  async function joinAsObserver(t: Table) {
    const inv = await invite(t);
    return app.joinAsObserver({ code: inv.code, displayName: '見学者' });
  }

  it('[US1.3/AC1.3.1] 進行役が招待を求めると、参加コードと別の招待コードが発行され、ロビーに有効な招待が並ぶ', async () => {
    const t = await setUpTable(3, false);
    const inv = await invite(t);
    const lobby = await app.lobby({ token: t.facilitator, gameId: t.gameId });
    expect(inv.code).not.toBe(lobby.joinCode);
    expect(lobby.observerInvitations).toEqual([
      { id: inv.invitationId, expiresAt: inv.expiresAt },
    ]);
    // 生の招待コードは保存しない
    expect(
      JSON.stringify([...mem.snapshot().invitations.values()]),
    ).not.toContain(inv.code);
  });

  it('[US1.3/AC1.3.2] 進行役以外は、招待を発行できない', async () => {
    const t = await setUpTable(3, false);
    await expect(
      app.issueObserverInvitation({
        token: t.players.RETAILER.token,
        gameId: t.gameId,
      }),
    ).rejects.toThrow(PermissionError);
  });

  it('[US1.3/AC1.3.3] 観察者は役割を持たず、参加者の一覧に出ない', async () => {
    const t = await setUpTable(3, false);
    const o = await joinAsObserver(t);
    expect(o.gameId).toBe(t.gameId);
    const lobby = await app.lobby({ token: t.facilitator, gameId: t.gameId });
    expect(lobby.participants).toHaveLength(4);
    expect(lobby.observerCount).toBe(1);
  });

  it('[US1.3/AC1.3.3][US4.1/AC4.1.5] 観察者は、入力・確定・進行・準備の操作ができない', async () => {
    const t = await setUpTable(3, false);
    const o = await joinAsObserver(t);
    const as = { token: o.token, gameId: t.gameId };
    await expect(app.startGame(as)).rejects.toThrow(PermissionError);
    await app.startGame({ token: t.facilitator, gameId: t.gameId });
    const ops = [
      app.saveDecision({
        ...as,
        role: 'RETAILER',
        quantity: 1,
        expectedVersion: 0,
      }),
      app.proxyDecision({
        ...as,
        role: 'RETAILER',
        quantity: 1,
        expectedVersion: 0,
      }),
      app.commitWeek({ ...as, week: 1, version: 0, idempotencyKey: 'k' }),
      app.pauseSession(as),
      app.changeCommitMode({ ...as, commitMode: 'AUTO' }),
      app.issueObserverInvitation(as),
      app.reissueCredential({ ...as, target: { kind: 'FACILITATOR' } }),
    ];
    for (const op of ops) await expect(op).rejects.toThrow(PermissionError);
  });

  it('[US4.1/AC4.1.2] 観察者は、役割別の状況・進行役のコンソール・ロビー・終了前の振り返りを取得できない', async () => {
    const t = await setUpTable();
    const inv = await app.issueObserverInvitation({
      token: t.facilitator,
      gameId: t.gameId,
    });
    const o = await app.joinAsObserver({ code: inv.code });
    const as = { token: o.token, gameId: t.gameId };
    await expect(app.roleState(as)).rejects.toThrow(ForbiddenError);
    await expect(app.console(as)).rejects.toThrow(ForbiddenError);
    await expect(app.lobby(as)).rejects.toThrow(ForbiddenError);
    await expect(app.review(as)).rejects.toThrow(PermissionError);
  });

  it('[US4.1/AC4.1.1] 観察者は、観察の投影を取得できる（役割別の値と需要を含まない）', async () => {
    const t = await setUpTable();
    const inv = await app.issueObserverInvitation({
      token: t.facilitator,
      gameId: t.gameId,
    });
    const o = await app.joinAsObserver({ code: inv.code });
    await fillAll(t, 6);
    const view = await app.observation({ token: o.token, gameId: t.gameId });
    expect(view).toMatchObject({
      week: 1,
      step: 'AWAITING_COMMIT',
      totals: { orders: 24 },
    });
  });

  it('[US4.1/AC4.1.4] 観察を開けるのは、そのゲームの観察者と進行役だけ（参加者・他のゲーム・資格なしは不可）', async () => {
    const t = await setUpTable();
    await expect(
      app.observation({ token: t.facilitator, gameId: t.gameId }),
    ).resolves.toBeDefined();
    await expect(
      app.observation({ token: t.players.RETAILER.token, gameId: t.gameId }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      app.observation({ token: '', gameId: t.gameId }),
    ).rejects.toThrow(UnauthorizedError);
    const other = await setUpTable();
    const inv = await app.issueObserverInvitation({
      token: other.facilitator,
      gameId: other.gameId,
    });
    const o = await app.joinAsObserver({ code: inv.code });
    await expect(
      app.observation({ token: o.token, gameId: t.gameId }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('[US1.3/AC1.3.4] 進行役が招待を失効させると、その招待での新しい参加はできない。参加済みの観察者は観察を続けられる', async () => {
    const t = await setUpTable();
    const inv = await invite(t);
    const before = await app.joinAsObserver({ code: inv.code });
    await app.revokeObserverInvitation({
      token: t.facilitator,
      gameId: t.gameId,
      invitationId: inv.invitationId,
    });
    await expect(app.joinAsObserver({ code: inv.code })).rejects.toThrow(
      UnauthorizedError,
    );
    await expect(
      app.observation({ token: before.token, gameId: t.gameId }),
    ).resolves.toBeDefined();
    const lobby = await app.lobby({ token: t.facilitator, gameId: t.gameId });
    expect(lobby.observerInvitations).toEqual([]);
  });

  it('観察用の招待は 24 時間で期限切れになる（境界）', async () => {
    const t = await setUpTable(3, false);
    const inv = await invite(t);
    advance(DAY - 1);
    await expect(app.joinAsObserver({ code: inv.code })).resolves.toBeDefined();
    advance(1);
    await expect(app.joinAsObserver({ code: inv.code })).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it('観察者は 1 ゲーム 20 人まで', async () => {
    const t = await setUpTable(3, false);
    const inv = await invite(t);
    for (let i = 0; i < 20; i++) await app.joinAsObserver({ code: inv.code });
    await expect(app.joinAsObserver({ code: inv.code })).rejects.toThrow(
      /20 人/,
    );
  });

  it('参加コードでは観察者として参加できず、招待コードでは参加者として参加できない', async () => {
    const t = await setUpTable(3, false);
    const inv = await invite(t);
    const lobby = await app.lobby({ token: t.facilitator, gameId: t.gameId });
    await expect(app.joinAsObserver({ code: lobby.joinCode! })).rejects.toThrow(
      UnauthorizedError,
    );
    await expect(
      app.joinGame({ joinCode: inv.code, displayName: 'x' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('[US4.2] 終了後は、観察者にも振り返りを開示する', async () => {
    const t = await setUpTable(1);
    const inv = await invite(t);
    const o = await app.joinAsObserver({ code: inv.code });
    await fillAll(t);
    const c = await app.console({ token: t.facilitator, gameId: t.gameId });
    await app.commitWeek({
      token: t.facilitator,
      gameId: t.gameId,
      week: 1,
      version: c.sessionVersion,
      idempotencyKey: 'end',
    });
    await expect(
      app.review({ token: o.token, gameId: t.gameId }),
    ).resolves.toMatchObject({ weeks: [1] });
  });

  it('変化の通知の認可は、そのゲームの観察者・参加者・進行役に通す', async () => {
    const t = await setUpTable(3, false);
    const o = await joinAsObserver(t);
    for (const token of [o.token, t.facilitator, t.players.FACTORY.token])
      await expect(
        app.authorizeStream({ token, gameId: t.gameId }),
      ).resolves.toBeUndefined();
    await expect(
      app.authorizeStream({ token: 'nope', gameId: t.gameId }),
    ).rejects.toThrow(UnauthorizedError);
  });
});

describe('出力（CSV・JSON）', () => {
  /** 2 週を通して終了させる（第 2 週は進行役の代理入力を含む） */
  async function endedTable() {
    const t = await setUpTable(2);
    for (const week of [1, 2]) {
      for (const role of ROLES) {
        if (week === 2 && role === 'FACTORY')
          await app.proxyDecision({
            token: t.facilitator,
            gameId: t.gameId,
            role,
            quantity: 9,
            expectedVersion: 0,
          });
        else
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
        idempotencyKey: `w${week}`,
      });
    }
    return t;
  }

  it('[US4.3/AC4.3.1] 終了後、進行役は JSON を出力でき、設定・全週・全役割・意思決定（代理入力の別と週）・履歴を含む', async () => {
    const t = await endedTable();
    const out = await app.exportGame({
      token: t.facilitator,
      gameId: t.gameId,
      format: 'json',
    });
    expect(out.contentType).toMatch(/application\/json/);
    expect(out.filename).toBe(`beer-game-${t.gameId}.json`);
    const doc = JSON.parse(out.body);
    expect(doc.schemaVersion).toBe('beer-game2.export.v1');
    expect(doc.game.settings.kind).toBe('KIT');
    expect(doc.weeks).toHaveLength(2);
    expect(doc.weeks[1].roles.FACTORY.order).toBe(9);
    expect(doc.inputs).toHaveLength(8);
    expect(doc.inputs).toContainEqual(
      expect.objectContaining({
        week: 2,
        role: 'FACTORY',
        quantity: 9,
        by: 'PROXY',
      }),
    );
    expect(doc.history.map((h: { type: string }) => h.type)).toEqual(
      expect.arrayContaining(['GameCreated', 'WeekCommitted', 'SessionEnded']),
    );
    // 表示名と資格の出来事は含めない
    expect(out.body).not.toContain('P-RETAILER');
    expect(out.body).not.toContain('Credential');
  });

  it('[US4.3/AC4.3.2] CSV と JSON の数量と費用が一致する', async () => {
    const t = await endedTable();
    const as = { token: t.facilitator, gameId: t.gameId };
    const json = JSON.parse(
      (await app.exportGame({ ...as, format: 'json' })).body,
    );
    const csv = (await app.exportGame({ ...as, format: 'csv' })).body;
    const [head, ...lines] = csv.trimEnd().split('\r\n');
    const keys = head!.split(',');
    expect(lines).toHaveLength(8);
    for (const line of lines) {
      const row = Object.fromEntries(
        line.split(',').map((v, i) => [keys[i], v]),
      );
      const v = json.weeks[Number(row.week) - 1].roles[row.role!];
      expect(Number(row.order)).toBe(v.order);
      expect(Number(row.cumulative_cost_minor)).toBe(v.cumulativeCostMinor);
    }
  });

  it('[US4.3] 出力は進行役だけで、終了後だけ', async () => {
    const t = await setUpTable(2);
    await expect(
      app.exportGame({ token: t.facilitator, gameId: t.gameId, format: 'csv' }),
    ).rejects.toThrow(PermissionError);
    const ended = await endedTable();
    await expect(
      app.exportGame({
        token: ended.players.RETAILER.token,
        gameId: ended.gameId,
        format: 'csv',
      }),
    ).rejects.toThrow(PermissionError);
    const inv = await app.issueObserverInvitation({
      token: ended.facilitator,
      gameId: ended.gameId,
    });
    const o = await app.joinAsObserver({ code: inv.code });
    await expect(
      app.exportGame({ token: o.token, gameId: ended.gameId, format: 'json' }),
    ).rejects.toThrow(PermissionError);
  });

  it('[US4.3/AC4.3.3] 記録が欠けていれば、部分的な結果を返さず失敗する', async () => {
    const t = await endedTable();
    const broken = createApplication({
      uow: mem.uow,
      clock: { now: () => now },
      ids: sequentialIds(),
      credentials: fakeCredentials(),
      reviews: memoryReviewReader(mem),
      exports: {
        read: async (gameId) => {
          const full = await memoryExportReader(mem).read(gameId);
          return {
            ...full,
            source: { ...full.source!, rows: full.source!.rows.slice(1) },
          };
        },
      },
    });
    await expect(
      broken.exportGame({
        token: t.facilitator,
        gameId: t.gameId,
        format: 'csv',
      }),
    ).rejects.toThrow(ExportIncompleteError);
  });

  it('[US4.3] 振り返りは、進行役にだけ「出力できる」と示す', async () => {
    const t = await endedTable();
    expect(
      (await app.review({ token: t.facilitator, gameId: t.gameId })).canExport,
    ).toBe(true);
    expect(
      (await app.review({ token: t.players.RETAILER.token, gameId: t.gameId }))
        .canExport,
    ).toBe(false);
  });
});

describe('保持と削除', () => {
  const RETENTION_DAY = 24 * 60 * 60 * 1000;

  it('[US5.1/AC5.1.1][US5.1/AC5.1.5] 作成すると保持期間 90 日が登録され、進行役のロビーに削除予定日とバックアップの期間が出る', async () => {
    const c = await app.createGame({ weeks: 3 });
    const lobby = await app.lobby({
      token: c.facilitatorToken,
      gameId: c.gameId,
    });
    expect(lobby.retention).toEqual({
      days: 90,
      deleteAfter: new Date(now.getTime() + 90 * RETENTION_DAY).toISOString(),
      backupDays: 7,
    });
  });

  it('[US5.1] 保持期間を指定して作成できる。範囲外は作成しない', async () => {
    const c = await app.createGame({ weeks: 3, retentionDays: 30 });
    const lobby = await app.lobby({
      token: c.facilitatorToken,
      gameId: c.gameId,
    });
    expect(lobby.retention?.days).toBe(30);
    await expect(
      app.createGame({ weeks: 3, retentionDays: 0 }),
    ).rejects.toThrow(DomainError);
    expect(mem.snapshot().games.size).toBe(1);
  });

  it('[US5.1/AC5.1.2] 期限に達したゲームだけを削除し、ゲーム記録・履歴・資格が消え、受領記録が残る', async () => {
    const t = await setUpTable(3);
    const keep = await app.createGame({ weeks: 3, retentionDays: 365 });
    advance(90 * RETENTION_DAY - 1);
    expect(await app.runRetention()).toMatchObject({ deleted: 0 });
    advance(1);
    const result = await app.runRetention();
    expect(result).toMatchObject({
      deleted: 1,
      failed: 0,
      permanentFailures: 0,
    });
    const store = mem.snapshot();
    expect(store.games.has(t.gameId)).toBe(false);
    expect(store.sessions.has(t.gameId)).toBe(false);
    expect(store.events.some((e) => e.gameId === t.gameId)).toBe(false);
    expect(
      [...store.credentials.values()].some(
        (c) => c.principal.gameId === t.gameId,
      ),
    ).toBe(false);
    expect(store.games.has(keep.gameId)).toBe(true);
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]).toMatchObject({ outcome: 'DELETED' });
    expect(JSON.stringify(store.receipts)).not.toContain(`"${t.gameId}"`);
    await expect(
      app.lobby({ token: t.facilitator, gameId: t.gameId }),
    ).rejects.toThrow(UnauthorizedError);
    // 2 回目の実行では、何も削除しない（一度だけ）
    expect(await app.runRetention()).toMatchObject({ deleted: 0 });
    expect(mem.snapshot().receipts).toHaveLength(1);
  });

  it('[US5.1/AC5.1.3] 削除の途中で失敗すると何も消えず、次の実行で再試行され、一度だけ削除される', async () => {
    const c = await app.createGame({ weeks: 3, retentionDays: 1 });
    advance(RETENTION_DAY);
    mem.failReceipt(true);
    expect(await app.runRetention()).toMatchObject({ deleted: 0, failed: 1 });
    expect(mem.snapshot().games.has(c.gameId)).toBe(true);
    expect(mem.snapshot().receipts).toHaveLength(0);
    mem.failReceipt(false);
    expect(await app.runRetention()).toMatchObject({ deleted: 1, failed: 0 });
    expect(mem.snapshot().games.has(c.gameId)).toBe(false);
    expect(mem.snapshot().receipts).toHaveLength(1);
  });

  it('[US5.1/AC5.1.3] 5 回失敗すると恒久的な失敗として数え、それ以降は再試行しない', async () => {
    await app.createGame({ weeks: 3, retentionDays: 1 });
    advance(RETENTION_DAY);
    mem.failReceipt(true);
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await app.runRetention());
    expect(results.map((r) => r.failed)).toEqual([1, 1, 1, 1, 1, 0]);
    expect(results[4]!.permanentFailures).toBe(1);
    expect(results[5]).toMatchObject({ deleted: 0, failed: 0 });
  });
});

describe('保持方針（コンソール）', () => {
  it('[US5.1/AC5.1.5] 進行役のコンソールにも、保持方針が出る', async () => {
    const t = await setUpTable();
    const c = await app.console({ token: t.facilitator, gameId: t.gameId });
    expect(c.retention).toMatchObject({ days: 90, backupDays: 7 });
  });
});

describe('保持の削除のメトリクス', () => {
  it('[US6.1/AC6.1.3] 削除の件数・失敗・恒久的な失敗をメトリクスに出す', async () => {
    const emitted: { name: string; value: number }[] = [];
    const withMetrics = createApplication({
      uow: mem.uow,
      clock: { now: () => now },
      ids: sequentialIds(),
      credentials: fakeCredentials(),
      reviews: memoryReviewReader(mem),
      exports: memoryExportReader(mem),
      metrics: { emit: (ms) => emitted.push(...ms) },
    });
    await withMetrics.createGame({ weeks: 3, retentionDays: 1 });
    advance(24 * 60 * 60 * 1000);
    await withMetrics.runRetention();
    expect(emitted).toEqual([
      { name: 'RetentionDeleted', value: 1, unit: 'Count' },
      { name: 'RetentionFailed', value: 0, unit: 'Count' },
      { name: 'RetentionPermanentFailures', value: 0, unit: 'Count' },
    ]);
  });
});
