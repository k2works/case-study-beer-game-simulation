import { describe, expect, it } from 'vitest';
import { FailureMemory } from '../../../src/server/retention/failure-memory.js';

const T0 = new Date('2026-11-01T00:00:00.000Z');
const plus = (ms: number): Date => new Date(T0.getTime() + ms);

describe('NFR2.4 FailureMemory: 失敗したゲームを 1 周期だけ選択から外す', () => {
  it('失敗の時刻から cooldown のあいだは除外し、過ぎたら戻す', () => {
    const memory = new FailureMemory({ cooldownMs: 3_600_000 });
    memory.record('g1', T0);
    expect(memory.excluded(plus(0))).toEqual(['g1']);
    expect(memory.excluded(plus(3_599_999))).toEqual(['g1']);
    expect(memory.excluded(plus(3_600_000))).toEqual([]);
    expect(memory.size()).toBe(0);
  });

  it('同じゲームが続けて失敗したら、除外の期限を延ばす', () => {
    const memory = new FailureMemory({ cooldownMs: 1000 });
    memory.record('g1', T0);
    memory.record('g1', plus(900));
    expect(memory.excluded(plus(1500))).toEqual(['g1']);
    expect(memory.excluded(plus(1900))).toEqual([]);
  });

  it('最大件数を超えたら、古い順に捨てる（既定 1000 件）', () => {
    const memory = new FailureMemory({ cooldownMs: 10_000, max: 3 });
    for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
      memory.record(id, plus(i));
    }
    expect(memory.size()).toBe(3);
    expect(memory.excluded(plus(5)).sort()).toEqual(['b', 'c', 'd']);
    expect(new FailureMemory({ cooldownMs: 1 }).size()).toBe(0);
  });

  it('成功したゲームは忘れられる', () => {
    const memory = new FailureMemory({ cooldownMs: 1000 });
    memory.record('g1', T0);
    memory.forget('g1');
    expect(memory.excluded(plus(1))).toEqual([]);
  });
});
