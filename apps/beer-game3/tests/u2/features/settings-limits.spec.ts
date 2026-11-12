import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/server/errors.js';
import { ROLES } from '../../../src/server/domain/types.js';
import { createWorld } from '../../u1/support/world.js';

async function problemOf(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe('設定値の上限（BR8.1）', () => {
  describe('上限の内側と外側', () => {
    const limits: Array<{ field: string; limit: number }> = [
      { field: 'initialInventory', limit: 9999 },
      { field: 'initialPipelineQuantity', limit: 9999 },
      { field: 'inventoryUnitCost', limit: 10000 },
      { field: 'backlogUnitCost', limit: 10000 },
    ];

    for (const { field, limit } of limits) {
      it(`Given ${field} が上限 ${limit} ちょうど / When 作成する / Then 受け付ける`, async () => {
        const world = createWorld();
        await expect(
          world.session.createGame({ name: '上限', weekCount: 6, [field]: limit }),
        ).resolves.toMatchObject({ weekCount: 6 });
      });

      it(`Given ${field} が上限 ${limit} を 1 超える / When 作成する / Then 422 validation で、項目と上限を案内する`, async () => {
        const world = createWorld();
        const error = await problemOf(
          world.session.createGame({ name: '上限超え', weekCount: 6, [field]: limit + 1 }),
        );
        expect(error.problem.kind).toBe('validation');
        expect(error.status).toBe(422);
        const found = error.problem.fields?.find((f) => f.path === field);
        expect(found?.message).toContain(String(limit));
      });
    }

    it('Given 需要系列の 1 つの値が 9999 / When 作成する / Then 受け付ける', async () => {
      const world = createWorld();
      await expect(
        world.session.createGame({
          name: '需要',
          weekCount: 3,
          demandSeries: [0, 9999, 1],
        }),
      ).resolves.toBeDefined();
    });

    it('Given 需要系列の 1 つの値が 10000 / When 作成する / Then 422 validation で、需要系列と上限を案内する', async () => {
      const world = createWorld();
      const error = await problemOf(
        world.session.createGame({ name: '需要超え', weekCount: 3, demandSeries: [4, 10000, 4] }),
      );
      expect(error.problem.kind).toBe('validation');
      const found = error.problem.fields?.find((f) => f.path === 'demandSeries');
      expect(found?.message).toContain('9999');
    });

    it('Given 複数の項目が上限超え / When 作成する / Then すべての項目が案内される', async () => {
      const world = createWorld();
      const error = await problemOf(
        world.session.createGame({
          name: '複数',
          weekCount: 6,
          initialInventory: 10000,
          backlogUnitCost: 10001,
        }),
      );
      const paths = (error.problem.fields ?? []).map((f) => f.path).sort();
      expect(paths).toEqual(['backlogUnitCost', 'initialInventory']);
    });
  });

  describe('上限ぎりぎりの設定でも、50 週の確定が成功する', () => {
    it('Given 上限の設定（在庫 9999・枠 9999・単価 10000・需要 9999）/ When 50 週を確定する / Then すべて成功し、費用は安全な整数に収まる', async () => {
      const world = createWorld();
      const game = await world.startedGame({
        weekCount: 50,
        initialInventory: 9999,
        initialPipelineQuantity: 9999,
        inventoryUnitCost: 10000,
        backlogUnitCost: 10000,
        demandSeries: Array.from({ length: 50 }, () => 9999),
      });
      let last;
      for (let week = 1; week <= 50; week += 1) {
        last = await world.playWeek(
          game,
          week,
          Object.fromEntries(ROLES.map((role) => [role, 9999])),
        );
      }
      expect(last?.status).toBe('ended');
      for (const row of last?.results ?? []) {
        expect(Number.isSafeInteger(row.cumulativeCost)).toBe(true);
        expect(Number.isSafeInteger(row.weeklyCost)).toBe(true);
      }
    });
  });
});
