import { describe, expect, it } from 'vitest';
import { FACILITATOR, participant } from '../../src/domain/actor.js';
import {
  assignRole,
  createGame,
  joinGame,
  startGame,
  type Game,
} from '../../src/domain/game.js';
import { ROLES } from '../../src/domain/role.js';
import {
  commitWeek,
  pauseSession,
  proxyDecision,
  resumeSession,
  saveDecision,
  startSession,
  type Session,
} from '../../src/domain/session.js';
import {
  DecisionConflictError,
  DomainError,
  PermissionError,
  StaleError,
} from '../../src/domain/values.js';

function startedGame(weeks = 3): Game {
  let g = createGame({ id: 'g1', joinCode: 'JOIN-0001', weeks }).game;
  ROLES.forEach((role, i) => {
    g = joinGame(g, { participantId: `p${i}`, displayName: `P${i}` }).game;
    g = assignRole(g, FACILITATOR, `p${i}`, role).game;
  });
  return startGame(g, FACILITATOR).game;
}
const holder = (role: (typeof ROLES)[number]) =>
  participant(`p${ROLES.indexOf(role)}`);

function newSession(weeks = 3): Session {
  return startSession(startedGame(weeks), 's1').session;
}

function fillAll(s: Session, quantity = 4): Session {
  let cur = s;
  for (const role of ROLES) {
    cur = saveDecision(
      cur,
      holder(role),
      role,
      quantity,
      cur.decisions[role]?.version ?? 0,
    ).session;
  }
  return cur;
}

describe('startSession', () => {
  it('[US2.1/AC2.1.1] 設定の写しと初期状態で、第 1 週から始まる', () => {
    const { session, events } = startSession(startedGame(), 's1');
    expect(session).toMatchObject({
      id: 's1',
      gameId: 'g1',
      status: 'ACTIVE',
      week: 1,
      version: 0,
      history: [],
      decisions: {},
    });
    expect(session.settings.finalWeek).toBe(3);
    expect(session.states.RETAILER.inventory).toBe(12);
    expect(events).toEqual([
      { type: 'SessionStarted', gameId: 'g1', sessionId: 's1' },
    ]);
  });

  it('準備中のゲームからは開始できない', () => {
    const g = createGame({ id: 'g1', joinCode: 'JOIN-0001', weeks: 3 }).game;
    expect(() => startSession(g, 's1')).toThrow(DomainError);
  });
});

describe('saveDecision', () => {
  it('[US2.2/AC2.2.1] 担当の参加者が、自分の役割の数量を保存できる', () => {
    const { session, events } = saveDecision(
      newSession(),
      holder('RETAILER'),
      'RETAILER',
      6,
      0,
    );
    expect(session.decisions.RETAILER).toEqual({
      quantity: 6,
      version: 1,
      savedBy: 'p3',
    });
    expect(session.version).toBe(1);
    expect(events).toEqual([
      {
        type: 'DecisionSaved',
        sessionId: 's1',
        role: 'RETAILER',
        quantity: 6,
        savedBy: 'p3',
        version: 1,
      },
    ]);
  });

  it('[US2.1/AC2.1.2] 担当でない役割には保存できない（権限エラー）', () => {
    expect(() =>
      saveDecision(newSession(), holder('FACTORY'), 'RETAILER', 6, 0),
    ).toThrow(PermissionError);
  });

  it.each([-1, 1001, 2.5])('[US2.2/AC2.2.2] 数量 %s は拒否する', (q) => {
    expect(() =>
      saveDecision(newSession(), holder('RETAILER'), 'RETAILER', q, 0),
    ).toThrow(DomainError);
  });

  it('[US2.2/AC2.2.2] 上書きでき、古い版の更新は最新値を示して拒否する', () => {
    const s1 = saveDecision(
      newSession(),
      holder('RETAILER'),
      'RETAILER',
      6,
      0,
    ).session;
    const s2 = saveDecision(s1, holder('RETAILER'), 'RETAILER', 7, 1).session;
    expect(s2.decisions.RETAILER?.quantity).toBe(7);
    expect(() =>
      saveDecision(s2, holder('RETAILER'), 'RETAILER', 8, 1),
    ).toThrow(/最新/);
  });

  it('進行中でなければ保存できない', () => {
    let s = fillAll(newSession(1));
    s = commitWeek(s, FACILITATOR, { week: 1, version: s.version }).session;
    expect(s.status).toBe('ENDED');
    expect(() => saveDecision(s, holder('RETAILER'), 'RETAILER', 1, 0)).toThrow(
      /終了/,
    );
  });

  it('進行役は、参加者の保存ではなく代理入力を使う', () => {
    expect(() =>
      saveDecision(newSession(), FACILITATOR, 'RETAILER', 1, 0),
    ).toThrow(PermissionError);
  });
});

describe('停止・再開（pauseSession / resumeSession）', () => {
  it('進行役が停止すると PAUSED になり、再開すると ACTIVE に戻る。版が進む', () => {
    const paused = pauseSession(newSession(), FACILITATOR);
    expect(paused.session.status).toBe('PAUSED');
    expect(paused.session.version).toBe(1);
    expect(paused.events).toEqual([{ type: 'SessionPaused', sessionId: 's1' }]);
    const resumed = resumeSession(paused.session, FACILITATOR);
    expect(resumed.session.status).toBe('ACTIVE');
    expect(resumed.session.version).toBe(2);
    expect(resumed.events).toEqual([
      { type: 'SessionResumed', sessionId: 's1' },
    ]);
  });

  it('進行役以外は、停止・再開できない', () => {
    expect(() => pauseSession(newSession(), holder('RETAILER'))).toThrow(
      PermissionError,
    );
    const paused = pauseSession(newSession(), FACILITATOR).session;
    expect(() => resumeSession(paused, holder('RETAILER'))).toThrow(
      PermissionError,
    );
  });

  it('停止中でなければ再開できず、進行中でなければ停止できない', () => {
    expect(() => resumeSession(newSession(), FACILITATOR)).toThrow(DomainError);
    const paused = pauseSession(newSession(), FACILITATOR).session;
    expect(() => pauseSession(paused, FACILITATOR)).toThrow(DomainError);
    let ended = fillAll(newSession(1));
    ended = commitWeek(ended, FACILITATOR, {
      week: 1,
      version: ended.version,
    }).session;
    expect(() => pauseSession(ended, FACILITATOR)).toThrow(/終了/);
  });

  it('[US3.1/AC3.1.1] 停止中に参加者が保存すると拒否し、保存済みの入力を失わない', () => {
    let s = saveDecision(
      newSession(),
      holder('RETAILER'),
      'RETAILER',
      6,
      0,
    ).session;
    s = pauseSession(s, FACILITATOR).session;
    expect(() => saveDecision(s, holder('RETAILER'), 'RETAILER', 9, 1)).toThrow(
      /停止中/,
    );
    expect(s.decisions.RETAILER).toMatchObject({ quantity: 6, version: 1 });
  });

  it('[US3.1/AC3.1.1] 停止中は、そろっていても週を確定できない', () => {
    let s = fillAll(newSession());
    s = pauseSession(s, FACILITATOR).session;
    expect(() =>
      commitWeek(s, FACILITATOR, { week: 1, version: s.version }),
    ).toThrow(/停止中/);
  });

  it('[US3.1/AC3.1.3] 再開すると、最後の確定済みの週の次から入力できる', () => {
    let s = fillAll(newSession());
    s = commitWeek(s, FACILITATOR, { week: 1, version: s.version }).session;
    s = pauseSession(s, FACILITATOR).session;
    s = resumeSession(s, FACILITATOR).session;
    expect(s.week).toBe(2);
    expect(s.history).toHaveLength(1);
    const saved = saveDecision(s, holder('FACTORY'), 'FACTORY', 3, 0).session;
    expect(saved.decisions.FACTORY?.quantity).toBe(3);
  });
});

describe('代理入力（proxyDecision）', () => {
  const at = new Date('2026-11-11T01:00:00.000Z');

  it('[US3.1/AC3.1.2] 進行役が代理入力すると、操作者・役割・時刻・値をイベントに残す', () => {
    const { session, events } = proxyDecision(
      newSession(),
      FACILITATOR,
      'WHOLESALER',
      7,
      0,
      at,
    );
    expect(session.decisions.WHOLESALER).toEqual({
      quantity: 7,
      version: 1,
      savedBy: 'FACILITATOR',
    });
    expect(events).toEqual([
      {
        type: 'ProxyDecisionSubmitted',
        sessionId: 's1',
        role: 'WHOLESALER',
        quantity: 7,
        version: 1,
        operator: 'FACILITATOR',
        at: '2026-11-11T01:00:00.000Z',
      },
    ]);
  });

  it('[US3.1/AC3.1.2] 停止中に代理入力し、再開してから確定できる', () => {
    let s = newSession();
    for (const role of ROLES.filter((r) => r !== 'WHOLESALER')) {
      s = saveDecision(s, holder(role), role, 4, 0).session;
    }
    s = pauseSession(s, FACILITATOR).session;
    s = proxyDecision(s, FACILITATOR, 'WHOLESALER', 5, 0, at).session;
    s = resumeSession(s, FACILITATOR).session;
    const committed = commitWeek(s, FACILITATOR, {
      week: 1,
      version: s.version,
    }).session;
    expect(committed.history[0]?.roles.WHOLESALER.order).toBe(5);
  });

  it('参加者は代理入力できない', () => {
    expect(() =>
      proxyDecision(newSession(), holder('RETAILER'), 'FACTORY', 1, 0, at),
    ).toThrow(PermissionError);
  });

  it('古い版の代理入力は、最新値を示して拒否する', () => {
    const s = saveDecision(
      newSession(),
      holder('RETAILER'),
      'RETAILER',
      6,
      0,
    ).session;
    expect(() => proxyDecision(s, FACILITATOR, 'RETAILER', 2, 0, at)).toThrow(
      StaleError,
    );
  });

  it('範囲外の数量と、終了後の代理入力は拒否する', () => {
    expect(() =>
      proxyDecision(newSession(), FACILITATOR, 'RETAILER', -1, 0, at),
    ).toThrow(DomainError);
    let ended = fillAll(newSession(1));
    ended = commitWeek(ended, FACILITATOR, {
      week: 1,
      version: ended.version,
    }).session;
    expect(() =>
      proxyDecision(ended, FACILITATOR, 'RETAILER', 1, 0, at),
    ).toThrow(/終了/);
  });

  it('自動確定のゲームでは、代理入力が最後の入力なら同じ操作で確定する', () => {
    let g = createGame({
      id: 'g1',
      joinCode: 'JOIN-0001',
      weeks: 3,
      commitMode: 'AUTO',
    }).game;
    ROLES.forEach((role, i) => {
      g = joinGame(g, { participantId: `p${i}`, displayName: `P${i}` }).game;
      g = assignRole(g, FACILITATOR, `p${i}`, role).game;
    });
    let s = startSession(startGame(g, FACILITATOR).game, 's1').session;
    for (const role of ROLES.filter((r) => r !== 'FACTORY')) {
      s = saveDecision(s, holder(role), role, 4, 0).session;
    }
    const { session, events } = proxyDecision(
      s,
      FACILITATOR,
      'FACTORY',
      4,
      0,
      at,
    );
    expect(session.week).toBe(2);
    expect(events.map((e) => e.type)).toEqual([
      'ProxyDecisionSubmitted',
      'WeekCommitted',
    ]);
  });
});

describe('自動確定（確定方式 AUTO）', () => {
  function autoSession(weeks = 3): Session {
    let g = createGame({
      id: 'g1',
      joinCode: 'J',
      weeks,
      commitMode: 'AUTO',
    }).game;
    ROLES.forEach((role, i) => {
      g = joinGame(g, { participantId: `p${i}`, displayName: `P${i}` }).game;
      g = assignRole(g, FACILITATOR, `p${i}`, role).game;
    });
    return startSession(startGame(g, FACILITATOR).game, 's1').session;
  }
  const save = (s: Session, role: (typeof ROLES)[number], q = 4) =>
    saveDecision(s, holder(role), role, q, s.decisions[role]?.version ?? 0);

  it('[US2.4/AC2.4.1] 最後の発注を保存すると、同じ操作で週が確定し、次の週へ進む', () => {
    let s = autoSession();
    for (const role of ['FACTORY', 'DISTRIBUTOR', 'WHOLESALER'] as const) {
      const out = save(s, role);
      s = out.session;
      expect(s.week).toBe(1);
      expect(out.events.map((e) => e.type)).toEqual(['DecisionSaved']);
    }
    const last = save(s, 'RETAILER');
    expect(last.session.week).toBe(2);
    expect(last.session.decisions).toEqual({});
    expect(last.session.history).toHaveLength(1);
    expect(last.session.history[0]?.commitKind).toBe('AUTO');
    expect(last.events.map((e) => e.type)).toEqual([
      'DecisionSaved',
      'WeekCommitted',
    ]);
  });

  it('[US2.4/AC2.4.2] 最終週の自動確定で、終了する', () => {
    let s = autoSession(1);
    for (const role of ROLES) s = save(s, role).session;
    expect(s.status).toBe('ENDED');
  });

  it('[US2.4] 手動（MANUAL）では、そろっても確定しない。手動の確定は種別 MANUAL で残る', () => {
    let s = newSession();
    for (const role of ROLES) s = save(s, role).session;
    expect(s.week).toBe(1);
    const done = commitWeek(s, FACILITATOR, {
      week: 1,
      version: s.version,
    }).session;
    expect(done.history[0]?.commitKind).toBe('MANUAL');
  });
});

describe('commitWeek', () => {
  it('[US2.3/AC2.3.1] 4 役割がそろえば、進行役が確定でき、週が進む', () => {
    const s = fillAll(newSession());
    const { session, events } = commitWeek(s, FACILITATOR, {
      week: 1,
      version: s.version,
    });
    expect(session.week).toBe(2);
    expect(session.status).toBe('ACTIVE');
    expect(session.decisions).toEqual({});
    expect(session.version).toBe(s.version + 1);
    expect(events.map((e) => e.type)).toEqual(['WeekCommitted']);
  });

  it('[US2.3/AC2.3.1] そろっていなければ、足りない役割を示して拒否する', () => {
    let s = newSession();
    s = saveDecision(s, holder('RETAILER'), 'RETAILER', 4, 0).session;
    try {
      commitWeek(s, FACILITATOR, { week: 1, version: s.version });
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).issues.map((i) => i.problem)).toEqual([
        'FACTORY の発注がありません',
        'DISTRIBUTOR の発注がありません',
        'WHOLESALER の発注がありません',
      ]);
    }
  });

  it('[US2.3/AC2.3.1] 進行役以外は確定できない', () => {
    const s = fillAll(newSession());
    expect(() =>
      commitWeek(s, holder('RETAILER'), { week: 1, version: s.version }),
    ).toThrow(PermissionError);
  });

  it('[US2.3/AC2.3.2] 週や版が現在と違えば、確定しない（一回性）', () => {
    const s = fillAll(newSession());
    const done = commitWeek(s, FACILITATOR, {
      week: 1,
      version: s.version,
    }).session;
    // 同じ要求の再実行は、週が進んでいるため拒否される
    expect(() =>
      commitWeek(done, FACILITATOR, { week: 1, version: s.version }),
    ).toThrow(/現在の週/);
    // 入力後に版が変わった（確認後に誰かが変更した）要求は拒否される
    expect(() =>
      commitWeek(s, FACILITATOR, { week: 1, version: s.version - 1 }),
    ).toThrow(/版/);
  });

  it('[US2.3/AC2.3.4] 週結果は決定論的で、役割別の発注と費用を含む（BR-09）', () => {
    let s = newSession();
    s = fillAll(s, 4);
    const a = commitWeek(s, FACILITATOR, {
      week: 1,
      version: s.version,
    }).session;
    const b = commitWeek(s, FACILITATOR, {
      week: 1,
      version: s.version,
    }).session;
    expect(a).toEqual(b);
    expect(a.history).toHaveLength(1);
    expect(a.history[0]).toMatchObject({ week: 1 });
    expect(a.history[0]?.roles.RETAILER).toMatchObject({
      order: 4,
      demand: 4,
      shipped: 4,
      endingInventory: 12,
      endingBacklog: 0,
      weeklyCostMinor: 600,
      cumulativeCostMinor: 600,
    });
  });

  it('[US2.3/AC2.3.5] 週結果が週ごと・役割ごとに履歴へ積まれる', () => {
    let s = newSession(3);
    for (let w = 1; w <= 2; w++) {
      s = fillAll(s);
      s = commitWeek(s, FACILITATOR, { week: w, version: s.version }).session;
    }
    expect(s.history.map((h) => h.week)).toEqual([1, 2]);
    expect(Object.keys(s.history[1]!.roles)).toEqual([...ROLES]);
  });

  it('[US2.3/AC2.3.1] 最終週を確定すると終了する', () => {
    let s = fillAll(newSession(1));
    const { session, events } = commitWeek(s, FACILITATOR, {
      week: 1,
      version: s.version,
    });
    expect(session.status).toBe('ENDED');
    expect(events.map((e) => e.type)).toEqual([
      'WeekCommitted',
      'SessionEnded',
    ]);
    s = session;
    expect(() =>
      commitWeek(s, FACILITATOR, { week: 1, version: s.version }),
    ).toThrow(/終了/);
  });
});

describe('共同担当と共同入力', () => {
  /** 小売店に p3 と p9（共同担当）がいるセッション */
  function coSession(): Session {
    let g = createGame({ id: 'g1', joinCode: 'JOIN-0001', weeks: 3 }).game;
    ROLES.forEach((role, i) => {
      g = joinGame(g, { participantId: `p${i}`, displayName: `P${i}` }).game;
      g = assignRole(g, FACILITATOR, `p${i}`, role).game;
    });
    g = joinGame(g, { participantId: 'p9', displayName: 'P9' }).game;
    g = assignRole(g, FACILITATOR, 'p9', 'RETAILER').game;
    return startSession(startGame(g, FACILITATOR).game, 's1').session;
  }

  it('[US1.2/AC1.2.4] 開始時に、役割ごとの担当の一覧を写す', () => {
    expect(coSession().holders.RETAILER).toEqual(['p3', 'p9']);
    expect(coSession().holders.FACTORY).toEqual(['p0']);
  });

  it('[US2.2/AC2.2.4] 共同担当の誰でも保存でき、1 つの値と版を共有する。保存者が残る', () => {
    let s = coSession();
    s = saveDecision(s, participant('p3'), 'RETAILER', 6, 0).session;
    const { session, events } = saveDecision(
      s,
      participant('p9'),
      'RETAILER',
      8,
      1,
    );
    expect(session.decisions.RETAILER).toEqual({
      quantity: 8,
      version: 2,
      savedBy: 'p9',
    });
    expect(events[0]).toMatchObject({ savedBy: 'p9', version: 2 });
  });

  it('[US2.2/AC2.2.3] 同じ版から後で保存すると、最新の値・版・保存者を持つ競合として拒否し、勝った更新を失わない', () => {
    const base = coSession();
    const first = saveDecision(
      base,
      participant('p3'),
      'RETAILER',
      6,
      0,
    ).session;
    try {
      saveDecision(first, participant('p9'), 'RETAILER', 10, 0);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DecisionConflictError);
      expect(e).toBeInstanceOf(StaleError);
      expect((e as DecisionConflictError).latest).toEqual({
        quantity: 6,
        version: 1,
        savedBy: 'p3',
      });
    }
    expect(first.decisions.RETAILER?.quantity).toBe(6);
  });

  it('未入力の役割に、古い版で保存したときの競合は、最新の値を持たない', () => {
    try {
      saveDecision(coSession(), participant('p3'), 'RETAILER', 1, 5);
      expect.unreachable();
    } catch (e) {
      expect((e as DecisionConflictError).latest).toBeNull();
    }
  });

  it('共同担当でない参加者は、その役割に保存できない', () => {
    expect(() =>
      saveDecision(coSession(), participant('p0'), 'RETAILER', 1, 0),
    ).toThrow(PermissionError);
  });
});
