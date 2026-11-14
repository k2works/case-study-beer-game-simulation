import { describe, expect, it } from 'vitest';
import { ROLES } from '../../../src/server/domain/types.js';
import { buildExportDocument } from '../../../src/server/reporting/export.js';
import { buildResultsView } from '../../../src/server/reporting/results.js';
import { newKey } from '../../u1/support/world.js';
import { buildRig, endedEarly, finishedGame, playedGame } from '../support/harness.js';

async function snapshotOf(
  prepare: (rig: ReturnType<typeof buildRig>) => Promise<{ gameId: string }>,
) {
  const rig = buildRig();
  const game = await prepare(rig);
  return (await rig.store.readSnapshot(game.gameId))!;
}

describe('BR21.3 BR21.4 buildResultsView: 確定済みの週だけを、許可リストの項目で整える', () => {
  it('項目は仕様のとおりで、値はすべて整数（セントを含む）', async () => {
    const snapshot = await snapshotOf((rig) => finishedGame(rig.world, 3));
    const view = buildResultsView(snapshot);
    expect(Object.keys(view).sort()).toEqual([
      'confirmedWeeks',
      'customerDemand',
      'gameId',
      'roles',
      'setupKind',
      'teamCumulativeCost',
      'weekCount',
    ]);
    expect(view.roles.map((r) => r.role)).toEqual([...ROLES]);
    for (const role of view.roles) {
      expect(Object.keys(role).sort()).toEqual(['role', 'weeks']);
      for (const week of role.weeks) {
        expect(Object.keys(week).sort()).toEqual([
          'backlog',
          'cumulativeCost',
          'decision',
          'inventory',
          'ordersReceived',
          'receipt',
          'shipped',
          'week',
          'weeklyCost',
        ]);
        expect(Object.values(week).every((value) => Number.isInteger(value))).toBe(true);
      }
    }
    expect(view.customerDemand).toEqual([8, 4, 6]);
  });

  it('チームの累積費用は、最終の確定週の 4 役割の累積費用の合計', async () => {
    const snapshot = await snapshotOf((rig) => finishedGame(rig.world, 3));
    const view = buildResultsView(snapshot);
    const sum = view.roles.reduce((total, r) => total + r.weeks.at(-1)!.cumulativeCost, 0);
    expect(view.teamCumulativeCost).toBe(sum);
    expect(sum).toBeGreaterThan(0);
  });

  it('確定前の入力（decision だけがある週）は含めない', async () => {
    const snapshot = await snapshotOf(async (rig) => {
      const game = await playedGame(rig.world, { weekCount: 5, confirmWeeks: 2 });
      await rig.world.session.submitDecision(
        game.players.factory.principal,
        game.gameId,
        3,
        'factory',
        { quantity: 7 },
        newKey('unconfirmed'),
      );
      await rig.world.session.endGame(game.facilitator, game.gameId);
      return game;
    });
    expect(snapshot.weekRecords.some((r) => r.week === 3 && r.decision === 7)).toBe(true);
    const view = buildResultsView(snapshot);
    expect(view.confirmedWeeks).toBe(2);
    expect(view.customerDemand).toHaveLength(2);
    expect(view.roles.every((r) => r.weeks.length === 2)).toBe(true);
  });

  it('確定済みの週がなければ、空の系列と 0（エラーにしない）', async () => {
    const snapshot = await snapshotOf((rig) => endedEarly(rig.world, 0, 4));
    const view = buildResultsView(snapshot);
    expect(view).toMatchObject({ confirmedWeeks: 0, customerDemand: [], teamCumulativeCost: 0 });
    expect(view.roles.map((r) => r.weeks)).toEqual([[], [], [], []]);
  });
});

describe('BR23.2 buildExportDocument: 1 週・1 役割を 1 行とする中間表現', () => {
  it('records は週の昇順、同じ週では役割の順。game は設定の写し', async () => {
    const snapshot = await snapshotOf((rig) => finishedGame(rig.world, 3));
    const document = buildExportDocument(snapshot);
    expect(document.records).toHaveLength(12);
    expect(document.records.map((r) => `${r.week}:${r.role}`)).toEqual(
      [1, 2, 3].flatMap((week) => ROLES.map((role) => `${week}:${role}`)),
    );
    expect(document.game).toMatchObject({
      gameId: snapshot.game.gameId,
      status: 'ended',
      endReason: 'finalWeek',
      weekCount: 3,
      confirmedWeeks: 3,
      demandSeries: [8, 4, 6],
      createdAt: snapshot.game.createdAt.toISOString(),
      endedAt: snapshot.game.endedAt!.toISOString(),
    });
  });

  it('結果画面の値と同じ数値を持つ（同じ確定済みの記録から作る）', async () => {
    const snapshot = await snapshotOf((rig) => finishedGame(rig.world, 3));
    const view = buildResultsView(snapshot);
    const document = buildExportDocument(snapshot);
    for (const record of document.records) {
      const week = view.roles.find((r) => r.role === record.role)!.weeks[record.week - 1]!;
      expect(record.weeklyCostCents).toBe(week.weeklyCost);
      expect(record.cumulativeCostCents).toBe(week.cumulativeCost);
      expect(record.decision).toBe(week.decision);
      expect(record.customerDemand).toBe(view.customerDemand[record.week - 1]);
    }
  });

  it('入力者: 参加者なら表示名、進行役なら種別だけ、移行前の記録は空', async () => {
    const snapshot = await snapshotOf((rig) => finishedGame(rig.world, 3));
    const retailer = snapshot.weekRecords.find((r) => r.week === 1 && r.role === 'retailer')!;
    retailer.decidedByKind = 'facilitator';
    retailer.decidedByParticipantId = null;
    const factory = snapshot.weekRecords.find((r) => r.week === 1 && r.role === 'factory')!;
    factory.decidedByKind = null;
    factory.decidedByParticipantId = null;
    const document = buildExportDocument(snapshot);
    const pick = (week: number, role: string) =>
      document.records.find((r) => r.week === week && r.role === role)!;
    expect(pick(1, 'retailer')).toMatchObject({
      decidedByKind: 'facilitator',
      decidedByDisplayName: null,
    });
    expect(pick(1, 'factory')).toMatchObject({ decidedByKind: null, decidedByDisplayName: null });
    expect(pick(2, 'wholesaler1')).toMatchObject({
      decidedByKind: 'participant',
      decidedByDisplayName: '一次卸',
    });
  });

  it('コード、token、ハッシュ、冪等の識別子、履歴の項目を持たない（許可リストの項目だけ）', async () => {
    const snapshot = await snapshotOf((rig) => finishedGame(rig.world, 3));
    const document = buildExportDocument(snapshot);
    const text = JSON.stringify(document);
    expect(text).not.toMatch(/token|hash|sealed|idempotency|sequence|participantId|code/i);
    expect(Object.keys(document.game).sort()).toEqual([
      'backlogUnitCostCents',
      'confirmedWeeks',
      'createdAt',
      'demandSeries',
      'endReason',
      'endedAt',
      'gameId',
      'initialInventory',
      'initialPipelineQuantity',
      'inventoryUnitCostCents',
      'name',
      'setupKind',
      'status',
      'weekCount',
    ]);
  });
});
