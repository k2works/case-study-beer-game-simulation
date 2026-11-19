import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createWorld } from '../../u1/support/world.js';
import { GOLDEN_SCRIPT, golden, playAndCompare } from '../support/golden.js';

describe('AC5.2.1 / BR8.3 50 週の golden test', () => {
  it('Given 既知の初期状態と意思決定系列 / When 50 週を進める / Then 全週・全役割の在庫・受注残・受注・入荷・出荷・費用と週末の遅延の枠が、別の計算の期待値と一致する', async () => {
    await playAndCompare(createWorld());
  }, 60_000);

  it('Given 同じ入力 / When もう一度 50 週を進める（別のゲーム）/ Then 同じく期待値と一致する（再現性）', async () => {
    await playAndCompare(createWorld());
  }, 60_000);

  it('Given 期待値の手計算による確認点 / Then 一致する（期待値の取り違えを防ぐ足場）', () => {
    // 週 1〜4: 全員が在庫 12・費用 600 のまま（入荷 = 出荷 = 4）
    expect(golden.weeks[0]?.teamCost).toBe(2400);
    expect(golden.weeks[3]?.teamCost).toBe(2400);
    // 週 5: 小売店は需要 8、入荷 4 → 在庫 12 + 4 - 8 = 8（費用 400）
    expect(golden.weeks[4]?.roles.retailer).toMatchObject({
      receipt: 4,
      ordersReceived: 8,
      shipped: 8,
      inventory: 8,
      weeklyCost: 400,
      cumulativeCost: 600 * 4 + 400,
    });
    // 週 6: 在庫 8 + 4 - 8 = 4（費用 200）
    expect(golden.weeks[5]?.roles.retailer).toMatchObject({ inventory: 4, weeklyCost: 200 });
  });

  it('導出の再現: derive-golden.mjs が、保存した期待値と同じものを作る（期待値は実装の出力のコピーではない）', () => {
    const output = execFileSync(process.execPath, [fileURLToPath(GOLDEN_SCRIPT), '--check'], {
      encoding: 'utf8',
    });
    expect(output).toContain('一致します');
  });
});
