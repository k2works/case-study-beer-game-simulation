import { describe, expect, it } from 'vitest';
import {
  buildLogEntry,
  participantLabel,
  toHistoryView,
} from '../../../src/server/session/history.js';

const base = {
  entryId: 'e1',
  actorKind: 'facilitator' as const,
  occurredAt: new Date('2026-11-12T09:00:00Z'),
};

describe('履歴の型（NFR7.1、BR13.6）', () => {
  it('kind ごとの detail を受け付け、sequence の昇順で返す', () => {
    const entry = buildLogEntry({ ...base, kind: 'pause', week: 3, detail: { week: 3 } });
    expect(entry).toMatchObject({ kind: 'pause', week: 3, role: null, detail: { week: 3 } });
    const view = toHistoryView([
      { ...entry, gameId: 'g', sequence: 2 },
      { ...entry, gameId: 'g', sequence: 1 },
    ]);
    expect(view.entries.map((e) => e.sequence)).toEqual([1, 2]);
    expect(view.entries[0]!.occurredAt).toBe('2026-11-12T09:00:00.000Z');
  });

  it('未知の項目（資格情報の値など）を持つ detail は保存できない', () => {
    expect(() =>
      buildLogEntry({
        ...base,
        kind: 'roleChange',
        detail: {
          change: 'replace',
          participantId: 'p',
          participantLabel: '新人 #5',
          toRole: 'retailer',
          gameStatus: 'running',
          token: 'tok_secret',
        } as never,
      }),
    ).toThrow();
    expect(() =>
      buildLogEntry({ ...base, kind: 'end', detail: { reason: 'nobody', week: 1 } as never }),
    ).toThrow();
    expect(() =>
      buildLogEntry({ ...base, kind: 'proxyInput', detail: { value: -1 } as never }),
    ).toThrow();
  });

  it('BR12.4 ラベルは「表示名 #参加順」', () => {
    expect(participantLabel({ displayName: '太郎', joinOrder: 3 })).toBe('太郎 #3');
  });
});
