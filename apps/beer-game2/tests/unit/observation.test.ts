import { describe, expect, it } from 'vitest';
import { FACILITATOR, participant } from '../../src/domain/actor.js';
import {
  assignRole,
  createGame,
  joinGame,
  startGame,
} from '../../src/domain/game.js';
import { observe } from '../../src/domain/observation.js';
import { ROLES } from '../../src/domain/role.js';
import {
  commitWeek,
  pauseSession,
  saveDecision,
  startSession,
  type Session,
} from '../../src/domain/session.js';

function newSession(disclosure?: 'TEAM_TOTAL' | 'PROGRESS_ONLY'): Session {
  let g = createGame({
    id: 'g1',
    joinCode: 'J',
    weeks: 3,
    ...(disclosure ? { conditions: { disclosure } } : {}),
  }).game;
  ROLES.forEach((role, i) => {
    g = joinGame(g, { participantId: `p${i}`, displayName: `P${i}` }).game;
    g = assignRole(g, FACILITATOR, `p${i}`, role).game;
  });
  return startSession(startGame(g, FACILITATOR).game, 's1').session;
}
const save = (s: Session, i: number, q: number) =>
  saveDecision(s, participant(`p${i}`), ROLES[i]!, q, 0).session;

describe('observe（観察の投影と開示の判定）', () => {
  it('[US4.1/AC4.1.1] 現在週・ステップ・完了状況を示す。確定前は在庫・受注残の合計が無い', () => {
    const o = observe(save(newSession(), 0, 4));
    expect(o).toMatchObject({
      status: 'ACTIVE',
      week: 1,
      step: 'INPUT',
      submitted: {
        FACTORY: true,
        DISTRIBUTOR: false,
        WHOLESALER: false,
        RETAILER: false,
      },
    });
    expect(o.totals).toMatchObject({
      lastCommittedWeek: null,
      inventory: null,
      backlog: null,
    });
  });

  it('[US4.1/AC4.1.1] 確定すると、最後に確定した週の在庫・受注残の 4 役割の合計を示す', () => {
    let s = newSession();
    for (let i = 0; i < 4; i++) s = save(s, i, 4);
    s = commitWeek(s, FACILITATOR, { week: 1, version: s.version }).session;
    const o = observe(s);
    expect(o.totals).toMatchObject({
      lastCommittedWeek: 1,
      inventory: 48,
      backlog: 0,
    });
  });

  it('[US4.1/AC4.1.1] 注文のチーム合計は、当週の入力済みの役割の合計。全員そろうと確定待ち', () => {
    let s = newSession();
    for (const [i, q] of [3, 5, 7, 9].entries()) s = save(s, i, q);
    const o = observe(s);
    expect(o.step).toBe('AWAITING_COMMIT');
    expect(o.totals?.orders).toBe(24);
  });

  it('[US4.1/AC4.1.3] 入力済みが 1 役割だけなら、注文の合計を非表示にする（個別の値の逆算を防ぐ）', () => {
    const o = observe(save(newSession(), 2, 7));
    expect(o.totals?.orders).toBeNull();
    expect(JSON.stringify(o)).not.toContain('7');
  });

  it('[US4.1/AC4.1.3] 入力済みが 2 役割以上なら、注文の合計を示す', () => {
    const o = observe(save(save(newSession(), 0, 3), 1, 5));
    expect(o.totals?.orders).toBe(8);
  });

  it('[US4.1/AC4.1.2] 役割別の値と需要を含まない（入力値・在庫・需要の系列）', () => {
    let s = newSession();
    for (let i = 0; i < 4; i++) s = save(s, i, 11 + i);
    s = commitWeek(s, FACILITATOR, { week: 1, version: s.version }).session;
    const o = observe(s);
    expect(Object.keys(o).sort()).toEqual(
      ['status', 'step', 'submitted', 'totals', 'week'].sort(),
    );
    const text = JSON.stringify(o);
    for (const v of ['11', '12', '13', '14', 'demand', 'RETAILER":{'])
      expect(text).not.toContain(v);
  });

  it('公開範囲が「進行状況だけ」なら、合計を出さない', () => {
    let s = newSession('PROGRESS_ONLY');
    for (let i = 0; i < 4; i++) s = save(s, i, 4);
    const o = observe(s);
    expect(o.totals).toBeNull();
    expect(o.step).toBe('AWAITING_COMMIT');
  });

  it('停止中と終了のステップ', () => {
    expect(observe(pauseSession(newSession(), FACILITATOR).session).step).toBe(
      'PAUSED',
    );
    let s = newSession();
    for (let w = 1; w <= 3; w++) {
      for (let i = 0; i < 4; i++) s = save(s, i, 4);
      s = commitWeek(s, FACILITATOR, { week: w, version: s.version }).session;
    }
    const o = observe(s);
    expect(o.step).toBe('ENDED');
    expect(o.totals?.lastCommittedWeek).toBe(3);
  });
});
