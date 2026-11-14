import { describe, expect, it } from 'vitest';
import {
  ReflectionMeter,
  WEEK_PATTERN_SOURCE,
  attachObserver,
  type ObservablePage,
} from '../../../verification/load/render-latency.js';

// 機能: 週確定の応答から、5 画面が新しい週を表示するまでを測る（NFR3.2）。疑似のページで確かめる

describe('シナリオ: 反映の測定（ReflectionMeter）', () => {
  it('Given 確定の応答を受けた時刻 When 5 画面が新しい週を観察する Then 画面ごとの差が標本になる', () => {
    const meter = new ReflectionMeter({ screens: 5, missingMs: 10000 });
    meter.markConfirmed(2, 1000);
    [1200, 1500, 1100, 2000, 1300].forEach((at, screen) => meter.observe(screen, 2, at));
    const result = meter.finalize();
    expect(result.samples.sort((a, b) => a - b)).toEqual([100, 200, 300, 500, 1000]);
    expect(result.missing).toBe(0);
    expect(result.clamped).toBe(0);
  });

  it('Given 始点より前の観察 When 記録する Then 0 に丸め、件数を記録する', () => {
    const meter = new ReflectionMeter({ screens: 2, missingMs: 10000 });
    meter.markConfirmed(2, 1000);
    meter.observe(0, 2, 990);
    meter.observe(1, 2, 1050);
    const result = meter.finalize();
    expect(result.samples.sort((a, b) => a - b)).toEqual([0, 50]);
    expect(result.clamped).toBe(1);
  });

  it('Given 新しい週が現れなかった画面 When 確定する Then 標本の値を 10 秒として入れ、missing を数える', () => {
    const meter = new ReflectionMeter({ screens: 3, missingMs: 10000 });
    meter.markConfirmed(2, 0);
    meter.observe(0, 2, 100);
    meter.observe(1, 2, 200);
    const result = meter.finalize();
    expect(result.samples.sort((a, b) => a - b)).toEqual([100, 200, 10000]);
    expect(result.missing).toBe(1);
  });

  it('Given 同じ画面が同じ週を 2 回観察する When 記録する Then 最初の 1 件だけを標本にする', () => {
    const meter = new ReflectionMeter({ screens: 1, missingMs: 10000 });
    meter.markConfirmed(2, 0);
    meter.observe(0, 2, 100);
    meter.observe(0, 2, 900);
    expect(meter.finalize().samples).toEqual([100]);
  });

  it('Given 複数の週 When 週ごとに確定する Then 週ごとの標本が累積する（10 週 × 5 画面 = 50 件）', () => {
    const meter = new ReflectionMeter({ screens: 5, missingMs: 10000 });
    for (let week = 2; week <= 11; week += 1) {
      meter.markConfirmed(week, week * 60_000);
      for (let screen = 0; screen < 5; screen += 1) {
        meter.observe(screen, week, week * 60_000 + 100 + screen * 10);
      }
    }
    expect(meter.finalize().samples).toHaveLength(50);
  });

  it('Given 古い週の観察 When 記録する Then 無視する（新しい週が現れたことにならない）', () => {
    const meter = new ReflectionMeter({ screens: 1, missingMs: 10000 });
    meter.markConfirmed(3, 0);
    meter.observe(0, 2, 50);
    expect(meter.finalize().missing).toBe(1);
  });
});

class FakePage implements ObservablePage {
  exposed = new Map<string, (...args: unknown[]) => void>();
  scripts: string[] = [];

  async exposeFunction(name: string, fn: (...args: never[]) => void): Promise<void> {
    this.exposed.set(name, fn as (...args: unknown[]) => void);
  }

  async addInitScript(script: string): Promise<void> {
    this.scripts.push(script);
  }
}

describe('シナリオ: ページの観察の仕組みの差し替え', () => {
  it('Given 疑似のページ When 観察を取り付ける Then ページ側の通知がノード側の時計で標本になる', async () => {
    const meter = new ReflectionMeter({ screens: 1, missingMs: 10000 });
    let now = 5000;
    const page = new FakePage();
    await attachObserver(page, 0, meter, () => now);
    meter.markConfirmed(2, 4000);
    now = 4600;
    page.exposed.get('__beerGame3Week')?.(2);
    expect(meter.finalize().samples).toEqual([600]);
    expect(page.scripts.join('\n')).toContain('MutationObserver');
  });

  it('週の表示の判定は「第 N 週 / M」の形', () => {
    const pattern = new RegExp(WEEK_PATTERN_SOURCE);
    expect(pattern.exec('第 3 週 / 12')?.[1]).toBe('3');
    expect(pattern.exec('ロビー')).toBeNull();
  });
});
