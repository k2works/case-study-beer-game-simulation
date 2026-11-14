/**
 * 閾値の判定（performance-requirements.md の NFR3.1〜NFR3.5、performance-design.md の「性能の予算」）。
 * 閾値は環境ごとに変えず、緩めない。短い試験は標本の多い指標だけで合否を決め、本試験はすべてを判定する。
 */

export interface MeasuredMetrics {
  /** 入力の確定の応答（95 パーセンタイル、ミリ秒）。標本がなければ null */
  inputConfirmP95: number | null;
  /** 週確定後の反映（仮想の利用者） */
  reflectionVirtualP95: number | null;
  /** 週確定後の反映（実ブラウザ） */
  reflectionBrowserP95: number | null;
  /** 取り直しの応答（通常負荷） */
  pollNormalP95: number | null;
  /** 取り直しの応答（最大想定） */
  pollPeakP95: number | null;
  serverErrors: number;
  timeouts: number;
  connectFailures: number;
  /** 429 と想定外の 4xx（有効な資格情報だけを使うため、0 件のはず） */
  unexpectedResponses: number;
  reflectionMissing: number;
  consistencyBroken: number;
  /** 測定器のイベントループの遅れ（99 パーセンタイル、ミリ秒） */
  eventLoopP99Ms: number;
}

export interface ThresholdOptions {
  mode: 'smoke' | 'main';
  /** 実ブラウザで見せるチームの数（0 なら実ブラウザの閾値を判定に使わない） */
  browserTeams: number;
  /** 最大想定の区間の長さ（0 なら判定に使わない） */
  peakSeconds: number;
  /** 実行側が決めた無効の理由（起動の失敗など） */
  invalidReason?: string;
}

export interface ThresholdItem {
  name: string;
  limit: number;
  actual: number | null;
  /** 閾値を満たしたか（判定に使わない指標では参考値） */
  pass: boolean;
  /** 合否の判定に使ったか */
  used: boolean;
  /** 記録のみの指標（短い試験の入力の確定と反映など） */
  recordedOnly: boolean;
}

export type Verdict = 'pass' | 'fail' | 'invalid';

export interface Evaluation {
  items: ThresholdItem[];
  verdict: Verdict;
  invalidReasons: string[];
  /** 合格 0、不合格 1、無効 2 */
  exitCode: 0 | 1 | 2;
}

/** 測定器のイベントループの遅れの上限（ミリ秒）。超えたら「無効」。 */
export const EVENT_LOOP_LIMIT_MS = 100;

type Source = Exclude<keyof MeasuredMetrics, 'eventLoopP99Ms' | 'reflectionMissing'>;

interface Def {
  name: string;
  source: Source;
  limit: number;
  /** 短い試験で合否に使うか */
  inSmoke: boolean;
}

const DEFS: readonly Def[] = [
  { name: 'inputConfirmP95', source: 'inputConfirmP95', limit: 1000, inSmoke: false },
  { name: 'reflectionVirtualP95', source: 'reflectionVirtualP95', limit: 2000, inSmoke: false },
  { name: 'reflectionBrowserP95', source: 'reflectionBrowserP95', limit: 2000, inSmoke: false },
  { name: 'pollNormalP95', source: 'pollNormalP95', limit: 500, inSmoke: true },
  { name: 'pollPeakP95', source: 'pollPeakP95', limit: 1000, inSmoke: false },
  { name: 'serverErrors', source: 'serverErrors', limit: 0, inSmoke: true },
  { name: 'timeouts', source: 'timeouts', limit: 0, inSmoke: true },
  { name: 'connectFailures', source: 'connectFailures', limit: 0, inSmoke: true },
  { name: 'unexpectedResponses', source: 'unexpectedResponses', limit: 0, inSmoke: true },
  { name: 'consistency', source: 'consistencyBroken', limit: 0, inSmoke: true },
];

function isUsed(def: Def, options: ThresholdOptions): boolean {
  if (def.name === 'reflectionBrowserP95' && options.browserTeams === 0) {
    return false;
  }
  if (def.name === 'pollPeakP95' && options.peakSeconds === 0) {
    return false;
  }
  return options.mode === 'main' || def.inSmoke;
}

export function evaluateThresholds(
  metrics: MeasuredMetrics,
  options: ThresholdOptions,
): Evaluation {
  const invalidReasons: string[] = [];
  if (options.invalidReason) {
    invalidReasons.push(options.invalidReason);
  }
  if (metrics.eventLoopP99Ms > EVENT_LOOP_LIMIT_MS) {
    invalidReasons.push('harness_saturated');
  }

  const items: ThresholdItem[] = DEFS.map((def) => {
    const actual = metrics[def.source];
    const used = isUsed(def, options);
    if (used && actual === null) {
      invalidReasons.push(`no_samples:${def.name}`);
    }
    return {
      name: def.name,
      limit: def.limit,
      actual,
      pass: actual === null ? !used : actual <= def.limit,
      used,
      recordedOnly: !used && options.mode === 'smoke' && !def.inSmoke,
    };
  });
  // reflectionMissing は常に記録のみ（標本の値 10 秒が百分位に入ることで合否が決まる）
  items.push({
    name: 'reflectionMissing',
    limit: 0,
    actual: metrics.reflectionMissing,
    pass: metrics.reflectionMissing === 0,
    used: false,
    recordedOnly: true,
  });

  if (invalidReasons.length > 0) {
    return { items, verdict: 'invalid', invalidReasons, exitCode: 2 };
  }
  const failed = items.some((item) => item.used && !item.pass);
  return failed
    ? { items, verdict: 'fail', invalidReasons, exitCode: 1 }
    : { items, verdict: 'pass', invalidReasons, exitCode: 0 };
}
