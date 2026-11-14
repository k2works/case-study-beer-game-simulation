import { cpus, platform, totalmem } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import pg from 'pg';
import type { Secret } from '../shared/secret.js';
import { weekCountFor, type VerifyConfig, type VerifyMode } from '../shared/config.js';
import { SeededPlan } from '../shared/rng.js';
import { buildSummary, type BrokenItem, type VerifySummary } from '../shared/summary.js';
import { checkTarget } from '../shared/target-guard.js';
import { evaluateThresholds, type Evaluation, type MeasuredMetrics } from '../shared/thresholds.js';
import { checkConsistency } from './consistency.js';
import { startApp, withLifecycle } from './lifecycle.js';
import { Recorder, type LedgerEntry } from './recorder.js';
import { openBrowserTeam, type BrowserTeam } from './render-latency.js';
import { TeamDriver } from './team-driver.js';

export type LogFn = (event: Record<string, unknown>) => void;

export interface RunOptions {
  config: VerifyConfig;
  mode: VerifyMode;
  /** 使い捨てのデータベースを作る管理用の接続（localhost のものだけ許可する） */
  adminDatabaseUrl: string;
  revision: { commit: string; branch: string };
  /** 構造化ログの出力先（許可リスト方式の項目だけを渡す） */
  log: LogFn;
  /** 外部の接続先を許可するか（VERIFY_ALLOW_REMOTE=1） */
  allowRemote?: boolean;
  /** 測定器のイベントループの遅れ（99 パーセンタイル、ミリ秒）の差し替え。試験用 */
  eventLoopP99Ms?: () => number;
}

export interface RunResult {
  summary: VerifySummary;
  /** 合格 0、不合格 1、無効 2 */
  exitCode: 0 | 1 | 2;
  /** 成功応答を受けた入力の台帳（チームの番号つき） */
  ledger: Array<LedgerEntry & { team: number }>;
  /** 生成した資格情報（要約に漏れていないことの確認に使う。出力しない） */
  secrets: Secret[];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

async function postgresVersion(adminUrl: string): Promise<string> {
  const client = new pg.Client({ connectionString: adminUrl });
  try {
    await client.connect();
    const result = await client.query<{ v: string }>(
      "select current_setting('server_version') as v",
    );
    return result.rows[0]?.v ?? 'unknown';
  } catch {
    return 'unknown';
  } finally {
    await client.end().catch(() => undefined);
  }
}

function emptyMetrics(): MeasuredMetrics {
  return {
    inputConfirmP95: null,
    reflectionVirtualP95: null,
    reflectionBrowserP95: null,
    pollNormalP95: null,
    pollPeakP95: null,
    serverErrors: 0,
    timeouts: 0,
    connectFailures: 0,
    unexpectedResponses: 0,
    reflectionMissing: 0,
    consistencyBroken: 0,
    eventLoopP99Ms: 0,
  };
}

function invalidResult(options: RunOptions, reason: string, startedAt: string): RunResult {
  const evaluation: Evaluation = {
    items: [],
    verdict: 'invalid',
    invalidReasons: [reason],
    exitCode: 2,
  };
  const summary = buildSummary({
    startedAt,
    finishedAt: new Date().toISOString(),
    revision: options.revision,
    mode: options.mode,
    config: options.config,
    external: false,
    environment: environmentInfo('unknown'),
    snapshot: new Recorder().snapshot(),
    consistency: { checkedGames: 0, broken: [] },
    harness: { eventLoopP99Ms: 0, saturated: false },
    evaluation,
  });
  return { summary, exitCode: 2, ledger: [], secrets: [] };
}

function environmentInfo(postgres: string) {
  return {
    cpus: cpus().length,
    memoryMb: Math.round(totalmem() / (1024 * 1024)),
    os: platform(),
    node: process.version,
    postgres,
    runner: process.env.CI ? ('ci' as const) : ('local' as const),
  };
}

/**
 * 負荷試験の実行（LoadRunner）。接続先を検査し、使い捨てのデータベースとアプリケーションを起動して、
 * 立ち上げ、通常負荷、最大想定の区間を順に動かし、整合性を検査して要約を返す。終了コードは合格 0、不合格 1、無効 2。
 */
export async function runVerification(options: RunOptions): Promise<RunResult> {
  const { config, log } = options;
  const startedAt = new Date().toISOString();

  const guard = checkTarget({
    databaseUrl: options.adminDatabaseUrl,
    allowRemote: options.allowRemote ?? false,
  });
  if (!guard.ok) {
    log({ event: 'verify_end', verdict: 'invalid', exitCode: 2, reason: 'target_not_allowed' });
    return invalidResult(options, 'target_not_allowed', startedAt);
  }

  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const recorder = new Recorder();
  const plan = new SeededPlan(config.seed);
  const weekCount = weekCountFor(config);
  const secrets: Secret[] = [];
  const gameTeam = new Map<string, number>();
  let disconnects = 0;
  let consistency: { checkedGames: number; broken: BrokenItem[] } = { checkedGames: 0, broken: [] };
  const browserRef: { team: BrowserTeam | null } = { team: null };
  let invalidReason: string | undefined;

  try {
    await withLifecycle(options.adminDatabaseUrl, async (env) => {
      const app = await startApp({ databaseUrl: env.databaseUrl });
      env.registerCleanup(() => app.stop());
      log({
        event: 'verify_start',
        teams: config.teams,
        normalSeconds: config.normalSeconds,
        peakSeconds: config.peakSeconds,
        seed: config.seed,
        database: env.databaseName,
      });

      const browserMeterHook: { mark: ((week: number, at: number) => void) | null } = {
        mark: null,
      };
      const teams = Array.from(
        { length: config.teams },
        (_, team) =>
          new TeamDriver({
            team,
            baseUrl: app.baseUrl,
            plan,
            recorder,
            weekCount,
            pollIntervalMs: config.pollIntervalMs,
            extraScreens: config.extraScreensPerTeam,
            browserTeam: team < config.browserTeams,
            onWeekConfirmed: (week, at) => {
              if (team < config.browserTeams && recorder.currentPhase() === 'normal') {
                browserMeterHook.mark?.(week, at);
              }
            },
          }),
      );

      // 立ち上げ: ゲームの作成、参加（追加の担当者も公開の参加手順で）、割当て、開始
      recorder.setPhase('warmup');
      log({ event: 'verify_phase', phase: 'warmup' });
      await Promise.all(teams.map((team) => team.setup()));
      for (const [index, team] of teams.entries()) {
        gameTeam.set(team.gameId, index);
        secrets.push(...team.secrets());
      }

      const browserTeam = teams[0];
      if (config.browserTeams > 0 && browserTeam) {
        const opened = await openBrowserTeam({
          baseUrl: app.baseUrl,
          gameId: browserTeam.gameId,
          facilitatorCode: browserTeam.facilitatorCode,
          participantTokens: browserTeam.playerTokens,
        });
        browserRef.team = opened;
        env.registerCleanup(() => opened.close());
        browserMeterHook.mark = (week, at) => opened.meter.markConfirmed(week, at);
      }

      for (const team of teams) {
        team.startNormalClients();
      }
      await sleep(config.warmupSeconds * 1000);

      // 通常負荷
      recorder.setPhase('normal');
      log({ event: 'verify_phase', phase: 'normal' });
      const normalStart = performance.now();
      const normalEnd = normalStart + config.normalSeconds * 1000;
      const runEnd = normalEnd + config.peakSeconds * 1000;
      const intervalMs = config.confirmIntervalSeconds * 1000;
      const cycles = teams.map(async (team, index) => {
        let next = normalStart + (index / teams.length) * intervalMs;
        while (next < runEnd) {
          await sleep(next - performance.now());
          if (performance.now() >= runEnd || team.hasFailed) {
            break;
          }
          await team.playWeek();
          next += intervalMs;
        }
      });

      // 切断の模擬: 通常負荷の中ごろで、1 つの画面の取り直しを数秒止める
      const disconnectTimer = setTimeout(() => {
        const first = teams[0];
        if (first) {
          disconnects += first.simulateDisconnect(Math.min(3000, config.normalSeconds * 250));
        }
      }, config.normalSeconds * 500);

      const progress = setInterval(() => {
        const snap = recorder.snapshot();
        log({
          event: 'verify_progress',
          elapsedSeconds: Math.round((performance.now() - normalStart) / 1000),
          phase: recorder.currentPhase(),
          polls: snap.phases[recorder.currentPhase()].poll.count,
        });
      }, 10_000);

      await sleep(normalEnd - performance.now());

      // 最大想定の区間: 追加の画面（立ち上げのうちに参加済み）が取り直しを始め、270 台にする
      if (config.peakSeconds > 0) {
        recorder.setPhase('peak');
        log({ event: 'verify_phase', phase: 'peak' });
        for (const team of teams) {
          team.startExtraClients();
        }
        await sleep(runEnd - performance.now());
      }

      for (const team of teams) {
        team.stopCycles();
      }
      await Promise.all(cycles);
      clearTimeout(disconnectTimer);
      clearInterval(progress);

      // 最後の週の反映が現れるのを、上限つきで待つ（取り直しは続けたまま）
      const deadline = performance.now() + 10_500;
      while (performance.now() < deadline && teams.some((team) => team.pendingReflections > 0)) {
        await sleep(100);
      }
      for (const team of teams) {
        team.flushPending();
      }
      await Promise.all(teams.map((team) => team.stopClients()));

      if (browserRef.team) {
        const collected = browserRef.team.meter.finalize();
        for (const value of collected.values) {
          recorder.recordReflection('browser', value, 'normal');
        }
        const counts = browserRef.team.errorCounts();
        log({ event: 'verify_error', kind: 'browser_page', ...counts });
      }

      consistency = await checkConsistency(env.databaseUrl, recorder.ledger());
      log({ event: 'verify_phase', phase: 'consistency', checkedGames: consistency.checkedGames });
    });
    log({ event: 'verify_cleanup', ok: true });
  } catch (error) {
    invalidReason = 'run_failed';
    log({
      event: 'verify_error',
      kind: 'run_failed',
      errorName: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    });
  } finally {
    histogram.disable();
  }

  const snapshot = recorder.snapshot();
  const rawLoop = options.eventLoopP99Ms
    ? options.eventLoopP99Ms()
    : histogram.percentile(99) / 1e6;
  const eventLoopP99Ms = Number.isFinite(rawLoop) ? Math.round(rawLoop * 10) / 10 : 0;
  const normal = snapshot.phases.normal;
  const metrics: MeasuredMetrics = {
    ...emptyMetrics(),
    inputConfirmP95: normal.inputConfirm.p95,
    reflectionVirtualP95: normal.reflectionVirtual.p95,
    reflectionBrowserP95: normal.reflectionBrowser.p95,
    pollNormalP95: normal.poll.p95,
    pollPeakP95: snapshot.phases.peak.poll.p95,
    serverErrors: snapshot.errors.http5xx,
    timeouts: snapshot.errors.timeout,
    connectFailures: snapshot.errors.connect,
    unexpectedResponses: snapshot.errors.rateLimited + snapshot.errors.unexpected4xx,
    reflectionMissing: snapshot.errors.reflectionMissing,
    consistencyBroken: consistency.broken.length,
    eventLoopP99Ms,
  };
  const evaluation = evaluateThresholds(metrics, {
    mode: options.mode,
    browserTeams: config.browserTeams,
    peakSeconds: config.peakSeconds,
    ...(invalidReason ? { invalidReason } : {}),
  });

  const summary = buildSummary({
    startedAt,
    finishedAt: new Date().toISOString(),
    revision: options.revision,
    mode: options.mode,
    config,
    external: guard.external,
    environment: environmentInfo(await postgresVersion(options.adminDatabaseUrl)),
    snapshot,
    consistency,
    harness: {
      eventLoopP99Ms,
      saturated: eventLoopP99Ms > 100,
      disconnectsSimulated: disconnects,
    },
    evaluation,
  });
  log({ event: 'verify_end', verdict: evaluation.verdict, exitCode: evaluation.exitCode });

  const ledger = recorder.ledger().map((entry) => ({
    ...entry,
    team: gameTeam.get(entry.gameId) ?? -1,
  }));
  return { summary, exitCode: evaluation.exitCode, ledger, secrets };
}
