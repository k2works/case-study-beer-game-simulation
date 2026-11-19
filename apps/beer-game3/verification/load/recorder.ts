import type { Role } from '../shared/roles.js';
import {
  MISSING_REFLECTION_SAMPLE_MS,
  TIMEOUT_SAMPLE_MS,
  summarize,
  type Stat,
} from '../shared/stats.js';

export type PhaseName = 'warmup' | 'normal' | 'peak';

/** 1 回の要求の結果。ok は応答を受け取れたとき（状態コードは問わない）。 */
export type Outcome =
  { kind: 'ok'; durationMs: number; status: number } | { kind: 'timeout' } | { kind: 'connect' };

export interface LedgerEntry {
  gameId: string;
  week: number;
  role: Role;
  quantity: number;
}

export interface ErrorCounts {
  http5xx: number;
  unavailable: number;
  rateLimited: number;
  unexpected4xx: number;
  connect: number;
  timeout: number;
  reflectionMissing: number;
}

export interface PhaseStats {
  inputConfirm: Stat;
  reflectionVirtual: Stat;
  reflectionBrowser: Stat;
  poll: Stat;
}

export interface RecorderSnapshot {
  phases: Record<PhaseName, PhaseStats>;
  errors: ErrorCounts;
  behind: number;
}

type Series = 'inputConfirm' | 'reflectionVirtual' | 'reflectionBrowser' | 'poll';

const SERIES: readonly Series[] = [
  'inputConfirm',
  'reflectionVirtual',
  'reflectionBrowser',
  'poll',
];
const PHASES: readonly PhaseName[] = ['warmup', 'normal', 'peak'];

/**
 * 標本と台帳を持つ（Recorder）。標本は区間の名前（warmup、normal、peak）を付けて全件を保持し、
 * 立ち上げ期間（warmup）は集計から分ける。タイムアウトと接続の失敗は、標本から落とさず 5 秒の標本として入れる。
 * 許可リスト方式で数値と識別子だけを持ち、資格情報は持たない。
 */
export class Recorder {
  private phase: PhaseName = 'warmup';
  private readonly samples: Record<PhaseName, Record<Series, number[]>> = {
    warmup: emptySeries(),
    normal: emptySeries(),
    peak: emptySeries(),
  };
  private readonly errors: ErrorCounts = {
    http5xx: 0,
    unavailable: 0,
    rateLimited: 0,
    unexpected4xx: 0,
    connect: 0,
    timeout: 0,
    reflectionMissing: 0,
  };
  private behind = 0;
  private readonly entries: LedgerEntry[] = [];

  setPhase(phase: PhaseName): void {
    this.phase = phase;
  }

  currentPhase(): PhaseName {
    return this.phase;
  }

  /** 取り直し 1 回。 */
  recordPoll(outcome: Outcome): void {
    this.record('poll', outcome);
  }

  /** 入力の確定 1 回。成功した値だけを台帳に載せる。 */
  recordInputConfirm(outcome: Outcome, entry: LedgerEntry): void {
    this.record('inputConfirm', outcome);
    if (outcome.kind === 'ok' && outcome.status >= 200 && outcome.status < 300) {
      this.entries.push({ ...entry });
    }
  }

  /** 進行役の「週の確定」の応答時間。標本には入れず、失敗の数だけを数える。 */
  recordWeekConfirm(outcome: Outcome): void {
    this.countFailure(outcome);
  }

  /** 週確定後の反映。null は、新しい週が 10 秒たっても現れなかった画面。 */
  recordReflection(
    source: 'virtual' | 'browser',
    valueMs: number | null,
    phase: PhaseName = this.phase,
  ): void {
    const series: Series = source === 'virtual' ? 'reflectionVirtual' : 'reflectionBrowser';
    if (valueMs === null) {
      this.errors.reflectionMissing += 1;
      this.samples[phase][series].push(MISSING_REFLECTION_SAMPLE_MS);
      return;
    }
    this.samples[phase][series].push(valueMs);
  }

  addBehind(count: number): void {
    this.behind += count;
  }

  ledger(): LedgerEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  snapshot(): RecorderSnapshot {
    const phases = {} as Record<PhaseName, PhaseStats>;
    for (const phase of PHASES) {
      phases[phase] = {
        inputConfirm: summarize(this.samples[phase].inputConfirm),
        reflectionVirtual: summarize(this.samples[phase].reflectionVirtual),
        reflectionBrowser: summarize(this.samples[phase].reflectionBrowser),
        poll: summarize(this.samples[phase].poll),
      };
    }
    return { phases, errors: { ...this.errors }, behind: this.behind };
  }

  private record(series: Series, outcome: Outcome): void {
    this.countFailure(outcome);
    const value = outcome.kind === 'ok' ? outcome.durationMs : TIMEOUT_SAMPLE_MS;
    this.samples[this.phase][series].push(value);
  }

  private countFailure(outcome: Outcome): void {
    if (outcome.kind === 'timeout') {
      this.errors.timeout += 1;
      return;
    }
    if (outcome.kind === 'connect') {
      this.errors.connect += 1;
      return;
    }
    const { status } = outcome;
    if (status >= 500) {
      this.errors.http5xx += 1;
      if (status === 503) {
        this.errors.unavailable += 1;
      }
    } else if (status === 429) {
      this.errors.rateLimited += 1;
    } else if (status >= 400) {
      this.errors.unexpected4xx += 1;
    }
  }
}

function emptySeries(): Record<Series, number[]> {
  const out = {} as Record<Series, number[]>;
  for (const series of SERIES) {
    out[series] = [];
  }
  return out;
}
