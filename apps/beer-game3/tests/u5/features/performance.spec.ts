import { describe, expect, it } from 'vitest';
import { buildU4App, getExport, getResults, json, playToEnd } from '../support/harness.js';

/**
 * NFR3.1、NFR3.2、NFR4.5: 50 週（200 行）のゲーム 1 件で、結果と出力の応答時間と大きさを測って記録する。
 * 負荷の下での測定は u6-nfr-verification が行う。ここでは、単独の要求が目標の内側にあることを確かめる。
 */
describe('50 週のゲームの結果と出力（メモリ上の保存）', () => {
  it('結果は 1 秒以内、CSV と JSON は 2 秒以内。出力の大きさは数十キロバイトに収まる', async ({
    annotate,
  }) => {
    const { app } = await buildU4App();
    const game = await playToEnd(app, 50);
    const measure = async <T>(run: () => Promise<T>): Promise<[T, number]> => {
      const started = performance.now();
      const value = await run();
      return [value, Math.round((performance.now() - started) * 10) / 10];
    };

    const [results, resultsMs] = await measure(() =>
      getResults(app, game.gameId, game.players.retailer.token),
    );
    const [csv, csvMs] = await measure(() =>
      getExport(app, game.gameId, game.facilitatorCode, 'csv'),
    );
    const [asJson, jsonMs] = await measure(() =>
      getExport(app, game.gameId, game.facilitatorCode, 'json'),
    );

    expect(results.statusCode).toBe(200);
    expect(csv.statusCode).toBe(200);
    expect(asJson.statusCode).toBe(200);
    expect(json(results).confirmedWeeks).toBe(50);
    expect(json(asJson).records).toHaveLength(200);
    await annotate(
      `50 週: 結果 ${resultsMs} ms（${Buffer.byteLength(results.body)} B）、CSV ${csvMs} ms（${Buffer.byteLength(csv.body)} B）、JSON ${jsonMs} ms（${Buffer.byteLength(asJson.body)} B）`,
    );
    expect(resultsMs).toBeLessThan(1000);
    expect(csvMs).toBeLessThan(2000);
    expect(jsonMs).toBeLessThan(2000);
    // 200 行 × 約 150 バイト（数十キロバイト）に収まる
    expect(Buffer.byteLength(csv.body)).toBeLessThan(100 * 1024);
    expect(Buffer.byteLength(asJson.body)).toBeLessThan(150 * 1024);
    // 50 週を HTTP で進める準備に数秒かかり、全体の実行中は既定の 5 秒を超えうる（測定するのは 3 つの応答だけ）
  }, 60_000);
});
