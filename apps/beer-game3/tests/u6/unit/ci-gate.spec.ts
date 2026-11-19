import { describe, expect, it } from 'vitest';
import {
  decideGate,
  type GateEvent,
  type GateInput,
  type JobResult,
} from '../../../verification/ci/gate.js';

// 機能: 必須のチェック gate の判定（cicd-pipeline.md「集約のジョブ gate」）
// 起動の種類 × relevant × 対象の branch × 各ジョブの結果の組み合わせ表で確かめる

type Results = GateInput['results'];

const S: JobResult = 'success';
const F: JobResult = 'failure';
const K: JobResult = 'skipped';
const C: JobResult = 'cancelled';

function results(
  changes: JobResult,
  verify: JobResult,
  e2e: JobResult,
  a11y: JobResult,
  loadSmoke: JobResult,
  loadMain: JobResult,
): Results {
  return { changes, verify, e2e, a11y, loadSmoke, loadMain };
}

const allSuccess = results(S, S, S, S, S, S);
const allSkippedAfterChanges = results(S, K, K, K, K, K);

function gate(event: GateEvent, relevant: string | undefined, baseRef: string, r: Results) {
  return decideGate({ event, relevant, baseRef, results: r }).ok;
}

describe('シナリオ: changes ジョブ', () => {
  it.each([F, C, K] as const)(
    'Given changes が %s When 判定する Then どの起動でも失敗',
    (changes) => {
      for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch'] as const) {
        expect(gate(event, 'true', 'develop', { ...allSuccess, changes }), event).toBe(false);
        expect(gate(event, 'false', 'develop', { ...allSkippedAfterChanges, changes }), event).toBe(
          false,
        );
      }
    },
  );
});

describe('シナリオ: 関係のない変更（relevant が false）', () => {
  it.each(['pull_request', 'push'] as const)(
    'Given %s で relevant=false When 他が skipped Then 成功',
    (event) => {
      expect(gate(event, 'false', 'develop', allSkippedAfterChanges)).toBe(true);
      expect(gate(event, 'false', 'main', allSkippedAfterChanges)).toBe(true);
    },
  );

  it.each([
    ['verify', results(S, F, K, K, K, K)],
    ['e2e', results(S, K, C, K, K, K)],
    ['a11y', results(S, K, K, F, K, K)],
    ['load-smoke', results(S, K, K, K, F, K)],
    ['load-main', results(S, K, K, K, K, F)],
  ])('Given relevant=false で %s が失敗や取り消し When 判定する Then 失敗', (_name, r) => {
    expect(gate('pull_request', 'false', 'develop', r)).toBe(false);
  });

  it('Given relevant=false なのに他のジョブが success（想定外）When 判定する Then 失敗（skipped であることを確かめる）', () => {
    expect(gate('pull_request', 'false', 'develop', allSuccess)).toBe(false);
  });
});

describe('シナリオ: 関係のある変更（relevant が false 以外はすべて true として扱う）', () => {
  it.each(['true', 'TRUE', '', 'yes', '1', 'garbage', undefined])(
    'Given relevant=%s で検証がすべて飛ばされた When 判定する Then 失敗（検証を要求する側に倒す）',
    (relevant) => {
      expect(gate('pull_request', relevant, 'develop', allSkippedAfterChanges)).toBe(false);
      expect(gate('push', relevant, 'develop', allSkippedAfterChanges)).toBe(false);
    },
  );

  it.each(['true', '', 'garbage', undefined])(
    'Given relevant=%s で 4 ジョブが成功し load-main が skipped When develop 宛ての PR と push Then 成功',
    (relevant) => {
      const r = results(S, S, S, S, S, K);
      expect(gate('pull_request', relevant, 'develop', r)).toBe(true);
      expect(gate('push', relevant, 'develop', r)).toBe(true);
      expect(gate('push', relevant, 'main', r)).toBe(true);
    },
  );

  it.each([
    ['verify', results(S, F, S, S, S, K)],
    ['verify が skipped', results(S, K, S, S, S, K)],
    ['e2e', results(S, S, F, S, S, K)],
    ['e2e が cancelled', results(S, S, C, S, S, K)],
    ['a11y', results(S, S, S, F, S, K)],
    ['load-smoke', results(S, S, S, S, F, K)],
    ['load-smoke が skipped', results(S, S, S, S, K, K)],
  ])('Given %s が成功でない When PR と push で判定する Then 失敗', (_name, r) => {
    expect(gate('pull_request', 'true', 'develop', r)).toBe(false);
    expect(gate('push', 'true', 'main', r)).toBe(false);
  });

  it('Given load-main が失敗や取り消し When develop 宛ての PR で判定する Then 失敗（走った結果は無視しない）', () => {
    expect(gate('pull_request', 'true', 'develop', results(S, S, S, S, S, F))).toBe(false);
    expect(gate('pull_request', 'true', 'develop', results(S, S, S, S, S, C))).toBe(false);
  });
});

describe('シナリオ: main を対象にした PR は load-main を必須にする', () => {
  it('Given relevant=true で load-main が success When main 宛ての PR Then 成功', () => {
    expect(gate('pull_request', 'true', 'main', allSuccess)).toBe(true);
  });

  it.each([K, F, C] as const)('Given load-main が %s When main 宛ての PR Then 失敗', (loadMain) => {
    expect(gate('pull_request', 'true', 'main', results(S, S, S, S, S, loadMain))).toBe(false);
  });

  it('Given relevant=false When main 宛ての PR で他がすべて skipped Then 成功（関係のない PR は通る）', () => {
    expect(gate('pull_request', 'false', 'main', allSkippedAfterChanges)).toBe(true);
  });

  it.each(['', 'weird', undefined])(
    'Given relevant=%s When main 宛ての PR で load-main が skipped Then 失敗',
    (relevant) => {
      expect(gate('pull_request', relevant, 'main', results(S, S, S, S, S, K))).toBe(false);
    },
  );
});

describe('シナリオ: 夜間と手動（schedule、workflow_dispatch）', () => {
  it.each(['schedule', 'workflow_dispatch'] as const)(
    'Given %s で load-main が success で他の 4 ジョブが skipped When 判定する Then 成功',
    (event) => {
      expect(gate(event, 'true', 'develop', results(S, K, K, K, K, S))).toBe(true);
    },
  );

  it.each(['schedule', 'workflow_dispatch'] as const)(
    'Given %s で全ジョブ success When 判定する Then 成功',
    (event) => {
      expect(gate(event, 'true', '', allSuccess)).toBe(true);
    },
  );

  it.each([F, C, K] as const)(
    'Given 夜間と手動で load-main が %s When 判定する Then 失敗',
    (loadMain) => {
      expect(gate('schedule', 'true', '', results(S, K, K, K, K, loadMain))).toBe(false);
      expect(gate('workflow_dispatch', 'true', '', results(S, K, K, K, K, loadMain))).toBe(false);
    },
  );

  it.each([
    ['verify', results(S, F, K, K, K, S)],
    ['e2e', results(S, K, C, K, K, S)],
    ['a11y', results(S, K, K, F, K, S)],
    ['load-smoke', results(S, K, K, K, F, S)],
  ])('Given 夜間で、走った %s が失敗や取り消し When 判定する Then 失敗', (_name, r) => {
    expect(gate('schedule', 'true', '', r)).toBe(false);
  });

  it('Given 夜間で relevant が false に見える値 When load-main が success Then 起動の種類で判定する（relevant に左右されない）', () => {
    expect(gate('schedule', 'false', '', results(S, K, K, K, K, S))).toBe(true);
    expect(gate('schedule', 'false', '', results(S, K, K, K, K, K))).toBe(false);
  });
});

describe('シナリオ: 理由の記録', () => {
  it('失敗の判定は、どのジョブが理由かを返す', () => {
    const decision = decideGate({
      event: 'pull_request',
      relevant: 'true',
      baseRef: 'develop',
      results: results(S, S, F, S, S, K),
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain('e2e');
  });

  it('知らない起動の種類は失敗にする（黙って通さない）', () => {
    expect(
      decideGate({
        event: 'release' as GateEvent,
        relevant: 'true',
        baseRef: '',
        results: allSuccess,
      }).ok,
    ).toBe(false);
  });
});
