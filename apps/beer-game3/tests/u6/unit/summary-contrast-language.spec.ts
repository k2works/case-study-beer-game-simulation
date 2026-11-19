import { describe, expect, it } from 'vitest';
import { SERIES_STYLES } from '../../../src/web/chart.js';
import {
  EXPORT_COLUMN_HELP,
  EXPORT_NOTICE,
  EXPORT_ROLE_HELP,
  DISPLAY_NAME_RULE,
  RESULTS_MESSAGES,
} from '../../../src/web/messages.js';
import { contrastRatio } from '../../../verification/shared/contrast.js';
import { findEnglishSentences } from '../../../verification/shared/language.js';
import { Recorder } from '../../../verification/load/recorder.js';
import { evaluateThresholds } from '../../../verification/shared/thresholds.js';
import {
  REQUIRED_SUMMARY_FIELDS,
  SUMMARY_SCHEMA_VERSION,
  buildSummary,
  renderStepSummary,
  type SummaryInput,
} from '../../../verification/shared/summary.js';
import { parseVerifyConfig } from '../../../verification/shared/config.js';

describe('シナリオ: 色の比（NFR8.3）', () => {
  it('Given 黒と白 When 比を計算する Then 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
  });

  it('Given 同じ色 Then 1:1', () => {
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });

  it('Given 既知の灰色 #767676 と白 Then 約 4.54:1（4.5 以上）', () => {
    const ratio = contrastRatio('#767676', '#ffffff');
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeLessThan(4.6);
  });

  it('Given 3 桁の表記 Then 6 桁と同じ値になる', () => {
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5);
  });

  it('Given 色でない文字列 Then 例外（黙って通さない）', () => {
    expect(() => contrastRatio('red', '#fff')).toThrow();
  });

  it('Given 結果のグラフの 4 つの系列の色 Then 白い背景に対して 3:1 以上（AC5.5.2）', () => {
    for (const [role, style] of Object.entries(SERIES_STYLES)) {
      expect(contrastRatio(style.color, '#ffffff'), role).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('シナリオ: 画面の文言に英語の文が混じらない（NFR11.1）', () => {
  it('findEnglishSentences は、3 語以上続く英語の並びを見つける', () => {
    expect(findEnglishSentences('Please enter your name here')).not.toEqual([]);
    expect(findEnglishSentences('これは Start Game Now というボタン')).not.toEqual([]);
  });

  it('識別子と短い略語、金額の記号は対象から除く', () => {
    expect(findEnglishSentences('CSV と JSON を出力する')).toEqual([]);
    expect(findEnglishSentences('列 customerDemand は個数、role は factory')).toEqual([]);
    expect(findEnglishSentences('費用 $12.50（セント: 1250）')).toEqual([]);
    expect(
      findEnglishSentences('発注を最後に保存した主体（participant: 参加者、facilitator: 進行役）'),
    ).toEqual([]);
  });

  it('Given messages.ts の文言の一覧 Then 英語の文が混じらない', () => {
    const texts: string[] = [
      EXPORT_NOTICE,
      DISPLAY_NAME_RULE,
      ...Object.values(RESULTS_MESSAGES),
      ...EXPORT_COLUMN_HELP.flatMap((c) => [c.meaning, c.unit]),
      ...EXPORT_ROLE_HELP.map((r) => r.label),
    ];
    for (const text of texts) {
      expect(findEnglishSentences(text), text).toEqual([]);
    }
  });
});

function sampleInput(extra: Record<string, unknown> = {}): SummaryInput {
  const recorder = new Recorder();
  recorder.setPhase('normal');
  recorder.recordPoll({ kind: 'ok', durationMs: 20, status: 200 });
  const parsed = parseVerifyConfig({}, 'smoke');
  if (!parsed.ok) {
    throw new Error('設定');
  }
  const snapshot = recorder.snapshot();
  const evaluation = evaluateThresholds(
    {
      inputConfirmP95: null,
      reflectionVirtualP95: null,
      reflectionBrowserP95: null,
      pollNormalP95: 20,
      pollPeakP95: null,
      serverErrors: 0,
      timeouts: 0,
      connectFailures: 0,
      unexpectedResponses: 0,
      reflectionMissing: 0,
      consistencyBroken: 0,
      eventLoopP99Ms: 5,
    },
    { mode: 'smoke', browserTeams: 0, peakSeconds: 0 },
  );
  return {
    startedAt: '2026-11-14T00:00:00.000Z',
    finishedAt: '2026-11-14T00:01:10.000Z',
    revision: { commit: 'abc123', branch: 'develop' },
    mode: 'smoke',
    config: parsed.config,
    external: false,
    environment: {
      cpus: 4,
      memoryMb: 16000,
      os: 'linux',
      node: 'v26.0.0',
      postgres: '18.6',
      runner: 'ci',
    },
    snapshot,
    consistency: { checkedGames: 15, broken: [] },
    harness: { eventLoopP99Ms: 5, saturated: false },
    evaluation,
    ...extra,
  } as SummaryInput;
}

describe('シナリオ: 結果の要約（JSON）', () => {
  it('Given 実行の結果 When 要約を作る Then 必須の欄がすべて揃う', () => {
    const summary = buildSummary(sampleInput());
    expect(summary.schemaVersion).toBe(SUMMARY_SCHEMA_VERSION);
    for (const field of REQUIRED_SUMMARY_FIELDS) {
      expect(summary, field).toHaveProperty(field);
    }
    expect(summary.verdict).toMatchObject({ result: 'pass' });
    expect(summary.thresholds.map((t) => t.name)).toContain('pollNormalP95');
    expect(summary.errors).toMatchObject({
      http5xx: 0,
      unavailable: 0,
      rateLimited: 0,
      connect: 0,
      timeout: 0,
      reflectionMissing: 0,
    });
    expect(summary.config).toMatchObject({ seed: expect.any(Number), external: false });
  });

  it('Given 許可リストにない項目や資格情報が入力に混ざる When 要約を作る Then 書かれない', () => {
    const input = sampleInput({
      joinCode: 'JOIN-SECRET-1',
      facilitatorCode: 'FAC-SECRET-2',
      returnToken: 'TOKEN-SECRET-3',
      databaseUrl: 'postgres://postgres:hunter2@localhost/db',
      env: { CODE_ENC_KEY: 'k1:xxxx' },
    });
    const text = JSON.stringify(buildSummary(input));
    for (const leaked of [
      'JOIN-SECRET-1',
      'FAC-SECRET-2',
      'TOKEN-SECRET-3',
      'hunter2',
      'k1:xxxx',
    ]) {
      expect(text).not.toContain(leaked);
    }
  });

  it('Given 崩れたゲーム When 要約を作る Then ゲームと週の識別子を出す（資格情報でない）', () => {
    const summary = buildSummary(
      sampleInput({
        consistency: {
          checkedGames: 2,
          broken: [{ gameId: 'g-1', week: 3, kind: 'missing_week' }],
        },
      }),
    );
    expect(summary.consistency.broken).toEqual([{ gameId: 'g-1', week: 3, kind: 'missing_week' }]);
  });

  it('Given 要約 When ジョブの要約の Markdown を作る Then 閾値ごとの実測と合否の表が出る', () => {
    const markdown = renderStepSummary(buildSummary(sampleInput()));
    expect(markdown).toContain('| 閾値 |');
    expect(markdown).toContain('pollNormalP95');
    expect(markdown).toMatch(/pass|合格/);
  });
});
