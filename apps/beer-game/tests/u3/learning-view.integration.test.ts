import { describe, expect, it } from 'vitest';
import { LearningViewService } from '../../src/learning/learning-view.js';

describe('C3 boundary validation', () => {
  it('quarantines an unknown schema major without advancing the cursor', () => {
    const service = new LearningViewService();
    expect(() =>
      service.consume({
        eventId: 'e1',
        eventType: 'WeekCommitted',
        gameId: 'g',
        sessionId: 's',
        aggregateVersion: 1,
        schemaVersion: 2 as 1,
        occurredAt: '',
        correlationId: '',
        data: {},
      }),
    ).toThrowError(/UNSUPPORTED_SCHEMA/);
    expect(service.cursor('g')).toBe(0);
  });

  it('rejects invalid envelopes at the trust boundary', () => {
    const service = new LearningViewService();
    expect(() => service.consume({} as never)).toThrow();
  });
});
