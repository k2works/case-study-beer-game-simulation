import { z } from 'zod';

export type VerifyMode = 'smoke' | 'main';

export interface VerifyConfig {
  teams: number;
  /** チームあたりの通常の画面の数（4 役割に 1 人ずつ、進行役 1） */
  screensPerTeam: number;
  /** チームあたりの追加の取り直し専用の画面の数（最大想定の区間のみ） */
  extraScreensPerTeam: number;
  pollIntervalMs: number;
  /** 1 チームが 1 週を確定する間隔（秒） */
  confirmIntervalSeconds: number;
  warmupSeconds: number;
  normalSeconds: number;
  peakSeconds: number;
  seed: number;
  /** 実ブラウザで見せるチームの数（本試験のみ 1） */
  browserTeams: number;
}

/** 設定の既定は、要件（scalability-design.md の表）の値。 */
export const DEFAULT_CONFIG: VerifyConfig = {
  teams: 15,
  screensPerTeam: 5,
  extraScreensPerTeam: 13,
  pollIntervalMs: 1000,
  confirmIntervalSeconds: 60,
  warmupSeconds: 10,
  normalSeconds: 600,
  peakSeconds: 180,
  seed: 20261113,
  browserTeams: 0,
};

const PRESETS: Record<VerifyMode, Partial<VerifyConfig>> = {
  smoke: { normalSeconds: 60, peakSeconds: 0, extraScreensPerTeam: 0, browserTeams: 0 },
  main: { browserTeams: 1 },
};

const ENV_NAMES: Record<keyof VerifyConfig, string> = {
  teams: 'VERIFY_TEAMS',
  screensPerTeam: 'VERIFY_SCREENS_PER_TEAM',
  extraScreensPerTeam: 'VERIFY_EXTRA_SCREENS_PER_TEAM',
  pollIntervalMs: 'VERIFY_POLL_INTERVAL_MS',
  confirmIntervalSeconds: 'VERIFY_CONFIRM_INTERVAL_SECONDS',
  warmupSeconds: 'VERIFY_WARMUP_SECONDS',
  normalSeconds: 'VERIFY_NORMAL_SECONDS',
  peakSeconds: 'VERIFY_PEAK_SECONDS',
  seed: 'VERIFY_SEED',
  browserTeams: 'VERIFY_BROWSER_TEAMS',
};

const range = (min: number, max: number) => z.int().min(min).max(max);

const schema = z
  .object({
    teams: range(1, 15),
    screensPerTeam: range(1, 5),
    extraScreensPerTeam: range(0, 13),
    pollIntervalMs: range(100, 10_000),
    confirmIntervalSeconds: range(1, 3600),
    warmupSeconds: range(0, 120),
    normalSeconds: range(1, 3600),
    peakSeconds: range(0, 3600),
    seed: range(0, 4_294_967_295),
    browserTeams: range(0, 1),
  })
  .superRefine((value, ctx) => {
    if (value.browserTeams > value.teams) {
      ctx.addIssue({
        code: 'custom',
        path: ['browserTeams'],
        message: '実ブラウザのチーム数はチーム数以下にしてください',
      });
    }
  });

export type ConfigResult = { ok: true; config: VerifyConfig } | { ok: false; problems: string[] };

/**
 * 環境変数（VERIFY_*）から設定を読む。モード（smoke、main）の既定の上に、明示した値を重ねる。
 * 不正な値は、実行前に終了コード 2 で失敗するため、問題の一覧（変数名つき）を返す。
 */
export function parseVerifyConfig(
  env: Record<string, string | undefined>,
  mode?: VerifyMode,
): ConfigResult {
  const raw: Record<string, unknown> = { ...DEFAULT_CONFIG, ...(mode ? PRESETS[mode] : {}) };
  const problems: string[] = [];
  for (const [key, name] of Object.entries(ENV_NAMES)) {
    const text = env[name]?.trim();
    if (text === undefined || text === '') {
      continue;
    }
    if (!/^-?\d+$/.test(text)) {
      problems.push(`${name} は整数で指定してください`);
      continue;
    }
    raw[key] = Number(text);
  }
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '') as keyof VerifyConfig;
      const name = ENV_NAMES[key] ?? String(key);
      problems.push(`${name}: ${issue.message}`);
    }
    return { ok: false, problems };
  }
  return { ok: true, config: parsed.data };
}

/** 確定が最後まで続けられる週数（最大 50）。区間の長さと確定の間隔から決め、余裕を 2 週足す。 */
export function weekCountFor(config: VerifyConfig): number {
  const seconds = config.warmupSeconds + config.normalSeconds + config.peakSeconds;
  return Math.min(50, Math.max(2, Math.ceil(seconds / config.confirmIntervalSeconds) + 2));
}
