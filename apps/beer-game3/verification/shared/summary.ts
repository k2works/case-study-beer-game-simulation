import type { RecorderSnapshot } from '../load/recorder.js';
import type { VerifyConfig, VerifyMode } from './config.js';
import type { Evaluation, ThresholdItem } from './thresholds.js';

/** 要約の形の版（整数。形を変えたら上げる）。 */
export const SUMMARY_SCHEMA_VERSION = 1;

export interface Environment {
  cpus: number;
  memoryMb: number;
  os: string;
  node: string;
  postgres: string;
  runner: 'ci' | 'local';
}

export interface BrokenItem {
  gameId: string;
  week: number;
  kind: string;
}

export interface SummaryInput {
  startedAt: string;
  finishedAt: string;
  revision: { commit: string; branch: string };
  mode: VerifyMode;
  config: VerifyConfig;
  /** 外部の接続先を許可して実行したか */
  external: boolean;
  environment: Environment;
  snapshot: RecorderSnapshot;
  consistency: { checkedGames: number; broken: BrokenItem[] };
  harness: { eventLoopP99Ms: number; saturated: boolean; disconnectsSimulated?: number };
  evaluation: Evaluation;
}

export interface VerifySummary {
  schemaVersion: number;
  startedAt: string;
  finishedAt: string;
  revision: { commit: string; branch: string };
  config: VerifyConfig & { mode: VerifyMode; external: boolean };
  environment: Environment;
  phases: {
    warmup: RecorderSnapshot['phases']['warmup'];
    normal: RecorderSnapshot['phases']['normal'];
    peak: RecorderSnapshot['phases']['peak'];
    behind: number;
  };
  errors: RecorderSnapshot['errors'];
  consistency: { checkedGames: number; broken: BrokenItem[] };
  harness: { eventLoopP99Ms: number; saturated: boolean; disconnectsSimulated: number };
  thresholds: ThresholdItem[];
  verdict: { result: Evaluation['verdict']; reasons: string[] };
}

/** 要約の必須の欄。 */
export const REQUIRED_SUMMARY_FIELDS = [
  'schemaVersion',
  'startedAt',
  'finishedAt',
  'revision',
  'config',
  'environment',
  'phases',
  'errors',
  'consistency',
  'harness',
  'thresholds',
  'verdict',
] as const;

/**
 * 要約を作る。許可リスト方式で項目を 1 つずつ写し、入力に余計な項目（資格情報、接続文字列、環境変数など）が
 * 混ざっても書けない作りにする（security-design.md、observability-design.md）。
 */
export function buildSummary(input: SummaryInput): VerifySummary {
  const { snapshot } = input;
  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    revision: { commit: input.revision.commit, branch: input.revision.branch },
    config: {
      mode: input.mode,
      external: input.external,
      teams: input.config.teams,
      screensPerTeam: input.config.screensPerTeam,
      extraScreensPerTeam: input.config.extraScreensPerTeam,
      pollIntervalMs: input.config.pollIntervalMs,
      confirmIntervalSeconds: input.config.confirmIntervalSeconds,
      warmupSeconds: input.config.warmupSeconds,
      normalSeconds: input.config.normalSeconds,
      peakSeconds: input.config.peakSeconds,
      seed: input.config.seed,
      browserTeams: input.config.browserTeams,
    },
    environment: {
      cpus: input.environment.cpus,
      memoryMb: input.environment.memoryMb,
      os: input.environment.os,
      node: input.environment.node,
      postgres: input.environment.postgres,
      runner: input.environment.runner,
    },
    phases: {
      warmup: snapshot.phases.warmup,
      normal: snapshot.phases.normal,
      peak: snapshot.phases.peak,
      behind: snapshot.behind,
    },
    errors: { ...snapshot.errors },
    consistency: {
      checkedGames: input.consistency.checkedGames,
      broken: input.consistency.broken.map((b) => ({
        gameId: b.gameId,
        week: b.week,
        kind: b.kind,
      })),
    },
    harness: {
      eventLoopP99Ms: input.harness.eventLoopP99Ms,
      saturated: input.harness.saturated,
      disconnectsSimulated: input.harness.disconnectsSimulated ?? 0,
    },
    thresholds: input.evaluation.items.map((item) => ({ ...item })),
    verdict: { result: input.evaluation.verdict, reasons: [...input.evaluation.invalidReasons] },
  };
}

const VERDICT_LABELS: Record<Evaluation['verdict'], string> = {
  pass: 'pass（合格）',
  fail: 'fail（不合格）',
  invalid: 'invalid（無効。アプリケーションの性能は判定できない）',
};

function cell(value: number | null): string {
  return value === null ? '—' : String(value);
}

/** GITHUB_STEP_SUMMARY に出す Markdown。閾値ごとの実測と合否の表。 */
export function renderStepSummary(summary: VerifySummary): string {
  const lines = [
    `## 負荷試験（${summary.config.mode}）: ${VERDICT_LABELS[summary.verdict.result]}`,
    '',
    `- 検査したコミット: ${summary.revision.commit}（${summary.revision.branch}）`,
    `- 設定: ${summary.config.teams} チーム、通常 ${summary.config.normalSeconds} 秒、最大想定 ${summary.config.peakSeconds} 秒、種 ${summary.config.seed}`,
    `- 整合性: ${summary.consistency.checkedGames} ゲームを検査、崩れ ${summary.consistency.broken.length} 件`,
    `- 測定器のイベントループの遅れ（99 パーセンタイル）: ${summary.harness.eventLoopP99Ms} ミリ秒`,
  ];
  if (summary.verdict.reasons.length > 0) {
    lines.push(`- 無効の理由: ${summary.verdict.reasons.join('、')}`);
  }
  lines.push(
    '',
    '| 閾値 | 上限 | 実測 | 判定 | 合否に使う |',
    '| :--- | ---: | ---: | :--- | :--- |',
  );
  for (const item of summary.thresholds) {
    const mark = item.pass ? '満たす' : '超過';
    const use = item.used ? '使う' : item.recordedOnly ? '記録のみ' : '対象外';
    lines.push(`| ${item.name} | ${item.limit} | ${cell(item.actual)} | ${mark} | ${use} |`);
  }
  return `${lines.join('\n')}\n`;
}
