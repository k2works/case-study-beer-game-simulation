import { performance } from 'node:perf_hooks';
import type { Secret } from '../shared/secret.js';
import { MISSING_REFLECTION_SAMPLE_MS } from '../shared/stats.js';

/**
 * 実ブラウザの反映の測定（performance-design.md「週確定後の画面反映の測り方」）。
 * 負荷試験と同じプロセスの中で Playwright のライブラリを直接使う（実行器とレポーターは使わない）。
 * 各画面のページに MutationObserver を入れ、新しい週の表示を検出したら、ノード側の関数を呼び、
 * ノード側の単調時計（performance.now()）で記録する。測定の始点は、週の確定の応答を受け取った時刻。
 */

/** 週の表示の判定。PlayScreen と FacilitatorBoard の「第 N 週 / M」の形。表や通知の「第 N 週」には一致しない。 */
export const WEEK_PATTERN_SOURCE = '第\\s*(\\d+)\\s*週\\s*/\\s*\\d+';

export interface MeterOptions {
  screens: number;
  /** 新しい週が現れなかった画面の標本の値（ミリ秒） */
  missingMs: number;
}

export interface Collected {
  /** 画面ごとの値（ミリ秒）。現れなかった画面は null */
  values: Array<number | null>;
  /** 現れなかった画面を missingMs として含めた標本 */
  samples: number[];
  missing: number;
  /** 始点より前の観察を 0 に丸めた件数 */
  clamped: number;
}

interface Pending {
  startedAt: number;
  observed: Map<number, number>;
  clamped: number;
}

/** 週の確定から各画面が新しい週を表示するまでの時間を集める（疑似のページでも使える）。 */
export class ReflectionMeter {
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly options: MeterOptions) {}

  /** 週の確定の応答を受け取った時刻。week は、新しく現れるはずの週の番号。 */
  markConfirmed(week: number, atMs: number): void {
    this.pending.set(week, { startedAt: atMs, observed: new Map(), clamped: 0 });
  }

  /** 画面 screen が、表示している週 week を観察した。同じ画面の 2 回目以降と古い週は数えない。 */
  observe(screen: number, week: number, atMs: number): void {
    for (const [target, entry] of this.pending) {
      if (week < target || entry.observed.has(screen)) {
        continue;
      }
      if (atMs < entry.startedAt) {
        entry.observed.set(screen, 0);
        entry.clamped += 1;
      } else {
        entry.observed.set(screen, atMs - entry.startedAt);
      }
    }
  }

  isComplete(week: number): boolean {
    const entry = this.pending.get(week);
    return entry !== undefined && entry.observed.size >= this.options.screens;
  }

  /** 1 つの週の結果を取り出す（以後は追跡しない）。 */
  collect(week: number): Collected {
    const entry = this.pending.get(week);
    this.pending.delete(week);
    if (!entry) {
      return { values: [], samples: [], missing: 0, clamped: 0 };
    }
    const values: Array<number | null> = [];
    for (let screen = 0; screen < this.options.screens; screen += 1) {
      values.push(entry.observed.get(screen) ?? null);
    }
    const samples = values.map((value) => value ?? this.options.missingMs);
    return {
      values,
      samples,
      missing: values.filter((value) => value === null).length,
      clamped: entry.clamped,
    };
  }

  /** 残りの週をすべて取り出して合わせる。 */
  finalize(): Collected {
    const total: Collected = { values: [], samples: [], missing: 0, clamped: 0 };
    for (const week of [...this.pending.keys()].sort((a, b) => a - b)) {
      const part = this.collect(week);
      total.values.push(...part.values);
      total.samples.push(...part.samples);
      total.missing += part.missing;
      total.clamped += part.clamped;
    }
    return total;
  }
}

/** ページの観察の仕組みを差し替えられるように、必要な面だけを持つ（疑似のページで試験する）。 */
export interface ObservablePage {
  exposeFunction(name: string, fn: (...args: never[]) => void): Promise<unknown>;
  addInitScript(script: string): Promise<unknown>;
}

export const OBSERVER_FUNCTION = '__beerGame3Week';

const OBSERVER_SCRIPT = `(() => {
  const pattern = new RegExp(${JSON.stringify(WEEK_PATTERN_SOURCE)});
  let last = -1;
  const check = () => {
    const text = document.body ? document.body.textContent || '' : '';
    const match = pattern.exec(text);
    if (match) {
      const week = Number(match[1]);
      if (week !== last) {
        last = week;
        window.${OBSERVER_FUNCTION}(week);
      }
    }
  };
  const start = () => {
    new MutationObserver(check).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    check();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();`;

/** ページに観察を取り付ける。ノード側で受け取った時刻を now()（performance.now()）で記録する。 */
export async function attachObserver(
  page: ObservablePage,
  screen: number,
  meter: ReflectionMeter,
  now: () => number = () => performance.now(),
): Promise<void> {
  await page.exposeFunction(OBSERVER_FUNCTION, (week: number) => {
    meter.observe(screen, week, now());
  });
  await page.addInitScript(OBSERVER_SCRIPT);
}

export interface BrowserTeamCredentials {
  baseUrl: string;
  gameId: string;
  facilitatorCode: Secret;
  /** 4 役割の参加者の復帰用 token */
  participantTokens: Secret[];
}

export interface BrowserTeam {
  meter: ReflectionMeter;
  /** ページのエラーの事象名と件数（許可リスト方式。内容は持たない） */
  errorCounts(): Record<string, number>;
  close(): Promise<void>;
}

/**
 * 1 チーム分（5 画面）の実ブラウザ（Chromium）を開き、画面が週を表示するまで待つ。
 * トレース、画面の画像、動画は取らない。資格情報は、このプロセスの中でブラウザの保存領域に入れるだけで、外へ出さない。
 */
export async function openBrowserTeam(creds: BrowserTeamCredentials): Promise<BrowserTeam> {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const meter = new ReflectionMeter({ screens: 5, missingMs: MISSING_REFLECTION_SAMPLE_MS });
  const errors: Record<string, number> = { pageerror: 0, requestfailed: 0, crash: 0 };
  const screens: Array<{ storage: 'local' | 'session'; key: string; secret: Secret }> = [
    ...creds.participantTokens.map((secret) => ({
      storage: 'local' as const,
      key: 'beerGame3.participant',
      secret,
    })),
    { storage: 'session', key: 'beerGame3.facilitator', secret: creds.facilitatorCode },
  ];
  try {
    for (const [index, screen] of screens.entries()) {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('pageerror', () => {
        errors.pageerror = (errors.pageerror ?? 0) + 1;
      });
      page.on('requestfailed', () => {
        errors.requestfailed = (errors.requestfailed ?? 0) + 1;
      });
      page.on('crash', () => {
        errors.crash = (errors.crash ?? 0) + 1;
      });
      await attachObserver(page, index, meter);
      await context.addInitScript(
        ({ storage, key, secret, gameId }) => {
          const target = storage === 'local' ? window.localStorage : window.sessionStorage;
          target.setItem(key, JSON.stringify({ secret, gameId }));
        },
        {
          storage: screen.storage,
          key: screen.key,
          secret: screen.secret.reveal(),
          gameId: creds.gameId,
        },
      );
      await page.goto(creds.baseUrl);
    }
    // すべての画面が週を表示するまで待つ（始点より前の観察は 0 に丸めるため、ここでの観察は標本にしない）
    for (const context of browser.contexts()) {
      const [page] = context.pages();
      await page?.waitForFunction(
        (source) => new RegExp(source).test(document.body.textContent ?? ''),
        WEEK_PATTERN_SOURCE,
        { timeout: 30_000 },
      );
    }
  } catch (error) {
    await browser.close();
    throw error;
  }
  return {
    meter,
    errorCounts: () => ({ ...errors }),
    close: () => browser.close(),
  };
}
