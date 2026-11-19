import { describe, expect, it } from 'vitest';
import { ROLES, type Role } from '../../../src/server/domain/types.js';
import type { ParticipantPrincipal } from '../../../src/server/access/access-control.js';
import { newKey } from '../../u1/support/world.js';
import { readRecords } from '../support/csv-reader.js';
import {
  bearer,
  bootGame,
  buildRig,
  buildU4App,
  getExport,
  getResults,
  json,
  playWeek,
  playToEnd,
  quantitiesOf,
  type Rig,
} from '../support/harness.js';

const COLUMNS = [
  'gameId',
  'setupKind',
  'week',
  'role',
  'customerDemand',
  'receipt',
  'ordersReceived',
  'shipped',
  'inventory',
  'backlog',
  'decision',
  'weeklyCostCents',
  'cumulativeCostCents',
  'decidedByKind',
  'decidedByDisplayName',
];

const LEGACY_NAME = '=HYPERLINK("http://example.invalid","x")';
const TRICKY_NAMES: Record<string, string> = {
  factory: 'Smith, John',
  wholesaler1: '改行\nのある名前',
  wholesaler2: '引用"符"の人',
};

/** 表示名にカンマ・改行・引用符・先頭が = のものを含むゲームを、最終週まで進める。 */
async function trickyGame(rig: Rig, weeks = 3) {
  const { world } = rig;
  const game = await world.createGame({ weekCount: weeks, demandSeries: [8, 4, 6] });
  const principals = {} as Record<Role, ParticipantPrincipal>;
  for (const role of ['factory', 'wholesaler1', 'wholesaler2'] as const) {
    const joined = await world.joinOne(game.joinCode, TRICKY_NAMES[role]!);
    await world.session.assignRole(game.facilitator, game.gameId, joined.participantId, role);
    principals[role] = (await world.as(joined.token)) as ParticipantPrincipal;
  }
  // 先頭が = の表示名は、いまは入力で拒否される。保存済みの値（以前の版）として直接入れる
  const legacyId = '33333333-3333-4333-8333-333333333333';
  await world.store.transact(game.gameId, async (tx) => {
    await tx.addParticipant(
      {
        participantId: legacyId,
        gameId: game.gameId,
        displayName: LEGACY_NAME,
        joinOrder: 4,
        joinedAt: world.clock.now(),
        replacedAt: null,
        createdByFacilitator: false,
      },
      'sha256:legacy-retailer',
      world.clock.now(),
    );
    await tx.setAssignment(legacyId, 'retailer', '44444444-4444-4444-8444-444444444444');
    await tx.updateGame({}, tx.game().version, []);
  });
  principals.retailer = {
    kind: 'participant',
    gameId: game.gameId,
    participantId: legacyId,
    role: 'retailer',
  };
  await world.session.startGame(game.facilitator, game.gameId);
  for (let week = 1; week <= weeks; week += 1) {
    for (const role of ROLES) {
      await world.session.submitDecision(
        principals[role],
        game.gameId,
        week,
        role,
        { quantity: quantitiesOf(week)[role] ?? 4 },
        newKey(`tricky-${role}-${week}`),
      );
    }
    await world.session.confirmWeek(game.facilitator, game.gameId, week, newKey(`tc-${week}`));
  }
  return game;
}

describe('US4.2 AC4.2.1 週ごと・役割ごとの列があり、キット準拠かカスタムかの区別を含む', () => {
  it('Given 終了したゲーム / When 進行役が CSV で出力する / Then 列、行数、BOM、ヘッダ、キャッシュしない指定がそろう', async () => {
    const { app, logs } = await buildU4App();
    const game = await playToEnd(app, 3);

    const response = await getExport(app, game.gameId, game.facilitatorCode, 'csv');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="beer-game-${game.gameId}.csv"`,
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body.startsWith('﻿')).toBe(true);
    const lines = response.body.slice(1).split('\r\n');
    expect(lines[0]).toBe(COLUMNS.join(','));
    expect(lines.at(-1)).toBe('');
    const records = readRecords(response.body);
    expect(records).toHaveLength(12);
    expect(records.map((r) => [r.week, r.role])).toEqual(
      [1, 2, 3].flatMap((week) => ROLES.map((role) => [week, role])),
    );
    expect(records.every((r) => r.setupKind === 'custom' && r.gameId === game.gameId)).toBe(true);
    expect(records.filter((r) => r.week === 1).map((r) => r.customerDemand)).toEqual([8, 8, 8, 8]);
    expect(logs.find((line) => line.event === 'export_served')).toMatchObject({
      kind: 'export:csv',
      gameId: game.gameId,
      rows: 12,
    });
  });

  it('BR23.2 出力の数値は、結果画面の値（確定した値）と一致し、金額は整数のセント', async () => {
    const { app } = await buildU4App();
    const game = await playToEnd(app, 3);
    const view = json(await getResults(app, game.gameId, game.facilitatorCode));
    const records = readRecords(
      (await getExport(app, game.gameId, game.facilitatorCode, 'csv')).body,
    );
    for (const record of records) {
      const role = (
        view.roles as Array<{ role: string; weeks: Array<Record<string, number>> }>
      ).find((r) => r.role === record.role)!;
      const week = role.weeks[(record.week as number) - 1]!;
      expect(record).toMatchObject({
        receipt: week.receipt,
        ordersReceived: week.ordersReceived,
        shipped: week.shipped,
        inventory: week.inventory,
        backlog: week.backlog,
        decision: week.decision,
        weeklyCostCents: week.weeklyCost,
        cumulativeCostCents: week.cumulativeCost,
      });
      expect(Number.isInteger(record.weeklyCostCents)).toBe(true);
    }
  });
});

describe('US4.2 AC4.2.2 同じゲームを JSON で出力すると、CSV と同じ数値が一致する', () => {
  it('Given 同じゲーム / When JSON で出力する / Then game と records を持ち、records は CSV を読み戻したものと完全に一致する', async () => {
    const { app } = await buildU4App();
    const game = await playToEnd(app, 3);

    const asJson = await getExport(app, game.gameId, game.facilitatorCode, 'json');
    const asCsv = await getExport(app, game.gameId, game.facilitatorCode, 'csv');

    expect(asJson.statusCode).toBe(200);
    expect(asJson.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(asJson.headers['content-disposition']).toBe(
      `attachment; filename="beer-game-${game.gameId}.json"`,
    );
    expect(asJson.headers['cache-control']).toBe('no-store');
    const document = json(asJson);
    expect(Object.keys(document).sort()).toEqual(['game', 'records']);
    expect(document.game).toMatchObject({
      gameId: game.gameId,
      name: 'U4 の試験',
      setupKind: 'custom',
      status: 'ended',
      endReason: 'finalWeek',
      weekCount: 3,
      confirmedWeeks: 3,
      initialInventory: 12,
      initialPipelineQuantity: 4,
      inventoryUnitCostCents: 50,
      backlogUnitCostCents: 100,
      demandSeries: [8, 4, 6],
    });
    expect(new Date(document.game.createdAt).toISOString()).toBe(document.game.createdAt);
    expect(new Date(document.game.endedAt).toISOString()).toBe(document.game.endedAt);
    expect(Object.keys(document.records[0]!)).toEqual(COLUMNS);
    expect(document.records).toEqual(readRecords(asCsv.body));
    for (const record of document.records as Array<Record<string, unknown>>) {
      expect(typeof record.week).toBe('number');
      expect(typeof record.weeklyCostCents).toBe('number');
    }
  });

  it('BR23.8 出力にコード、token、ハッシュ、冪等の識別子、操作の履歴を含めない', async () => {
    const { app } = await buildU4App();
    const game = await playToEnd(app, 3);
    for (const format of ['csv', 'json']) {
      const body = (await getExport(app, game.gameId, game.facilitatorCode, format)).body;
      for (const secret of [
        game.joinCode,
        game.facilitatorCode,
        game.observerCode,
        ...ROLES.map((role) => game.players[role].token),
        'sha256',
        'idempotency',
        'sequence',
        'actorKind',
      ]) {
        expect(body, `${format} に ${secret.slice(0, 6)} が含まれる`).not.toContain(secret);
      }
    }
  });
});

describe('US4.2 AC4.2.3 表示名にカンマと改行を含む参加者がいても、行が崩れず、値は元のまま読み戻せる', () => {
  it('Given カンマ・改行・引用符・先頭が = の表示名 / When CSV で出力する / Then 行は崩れず、値は元のまま', async () => {
    const rig = buildRig();
    const game = await trickyGame(rig);
    const { app } = await buildU4App({ store: rig.store, clock: rig.world.clock });

    const response = await getExport(app, game.gameId, game.facilitatorCode, 'csv');

    expect(response.statusCode).toBe(200);
    const records = readRecords(response.body);
    expect(records).toHaveLength(12);
    const nameOf = (role: Role) =>
      new Set(records.filter((r) => r.role === role).map((r) => r.decidedByDisplayName));
    expect(nameOf('factory')).toEqual(new Set(['Smith, John']));
    expect(nameOf('wholesaler1')).toEqual(new Set(['改行\nのある名前']));
    expect(nameOf('wholesaler2')).toEqual(new Set(['引用"符"の人']));
    // 先頭が = でも、値は変えない（先頭に文字を足さない）
    expect(nameOf('retailer')).toEqual(new Set([LEGACY_NAME]));
    expect(response.body).toContain('"Smith, John"');
    expect(response.body).toContain('"引用""符""の人"');
    expect(response.body).toContain(`"${LEGACY_NAME.replaceAll('"', '""')}"`);
    expect(records.every((r) => r.decidedByKind === 'participant')).toBe(true);
  });

  it('同じゲームの JSON の表示名も、CSV を読み戻した値と同じ', async () => {
    const rig = buildRig();
    const game = await trickyGame(rig);
    const { app } = await buildU4App({ store: rig.store, clock: rig.world.clock });
    const csv = readRecords((await getExport(app, game.gameId, game.facilitatorCode, 'csv')).body);
    const doc = json(await getExport(app, game.gameId, game.facilitatorCode, 'json'));
    expect(doc.records).toEqual(csv);
  });

  it('入力者の表示名は、入れ替え済みの参加者も含む。進行役の代理入力は種別だけで、名前は空', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app, { weekCount: 2, demandSeries: [4, 4] });
    await playWeek(app, game, 1);
    const replaced = await app.inject({
      method: 'POST',
      url: `/api/games/${game.gameId}/roles/retailer/replacement`,
      headers: game.facilitator,
      payload: { participantId: game.players.retailer.participantId, displayName: '交代した人' },
    });
    const newToken = json(replaced).token as string;
    const input = (credential: string, role: Role, key: string) =>
      app.inject({
        method: 'PUT',
        url: `/api/games/${game.gameId}/weeks/2/decisions/${role}`,
        headers: { ...bearer(credential), 'idempotency-key': newKey(key) },
        payload: { quantity: 5 },
      });
    await input(game.facilitatorCode, 'factory', 'proxy');
    await input(game.players.wholesaler1.token, 'wholesaler1', 'w1');
    await input(game.players.wholesaler2.token, 'wholesaler2', 'w2');
    await input(newToken, 'retailer', 'r');
    await app.inject({
      method: 'POST',
      url: `/api/games/${game.gameId}/weeks/2/confirm`,
      headers: { ...game.facilitator, 'idempotency-key': newKey('confirm2') },
    });

    const records = readRecords(
      (await getExport(app, game.gameId, game.facilitatorCode, 'csv')).body,
    );
    const pick = (week: number, role: Role) =>
      records.find((r) => r.week === week && r.role === role)!;
    expect(pick(1, 'retailer')).toMatchObject({
      decidedByKind: 'participant',
      decidedByDisplayName: '小売店',
    });
    expect(pick(2, 'retailer')).toMatchObject({
      decidedByKind: 'participant',
      decidedByDisplayName: '交代した人',
    });
    expect(pick(2, 'factory')).toMatchObject({
      decidedByKind: 'facilitator',
      decidedByDisplayName: null,
    });
  });
});

describe('BR23.1 出力は進行役だけ、終了したゲームだけ', () => {
  it('参加者、観察者、資格情報なし、別のゲームの進行役は、同じ 403 の本文', async () => {
    const { app } = await buildU4App();
    const game = await playToEnd(app, 3);
    const other = await playToEnd(app, 3);
    const none = await getExport(app, game.gameId, undefined, 'csv');
    expect(none.statusCode).toBe(403);
    for (const credential of [
      game.players.retailer.token,
      game.players.factory.token,
      game.observerCode,
      other.facilitatorCode,
      'tok_garbage',
    ]) {
      const response = await getExport(app, game.gameId, credential, 'csv');
      expect(response.statusCode, credential).toBe(403);
      expect(response.json()).toEqual(none.json());
    }
  });

  it('進行役でも、終了前は 409（理由と直し方つき）で、データを返さない', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app);
    await playWeek(app, game, 1);
    const response = await getExport(app, game.gameId, game.facilitatorCode, 'csv');
    expect(response.statusCode).toBe(409);
    expect(json(response)).toMatchObject({
      kind: 'state',
      hint: 'ゲームを終了してから出力してください',
    });
    expect(response.body).not.toContain(game.gameId);
  });

  it('format が csv でも json でもない、または欠落は 422（認可のあと）。権限のない人には 422 を見せない', async () => {
    const { app } = await buildU4App();
    const game = await playToEnd(app, 3);
    for (const format of [undefined, '', 'xml', 'CSV', 'csv,json']) {
      const response = await getExport(app, game.gameId, game.facilitatorCode, format);
      expect(response.statusCode, String(format)).toBe(422);
      expect(json(response).kind).toBe('validation');
      const stranger = await getExport(app, game.gameId, game.players.retailer.token, format);
      expect(stranger.statusCode).toBe(403);
    }
  });

  it('途中で終了したゲームは、確定済みの週の行だけを出す', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app, { weekCount: 6, demandSeries: [4, 4, 4, 4, 4, 4] });
    await playWeek(app, game, 1);
    await playWeek(app, game, 2);
    await app.inject({
      method: 'POST',
      url: `/api/games/${game.gameId}/end`,
      headers: game.facilitator,
    });
    const doc = json(await getExport(app, game.gameId, game.facilitatorCode, 'json'));
    expect(doc.game).toMatchObject({ confirmedWeeks: 2, weekCount: 6, endReason: 'facilitator' });
    expect(doc.records).toHaveLength(8);
  });

  it('出力は読み取りだけ: 版と最後の操作の時刻は変わらない', async () => {
    const { app, store, clock } = await buildU4App();
    const game = await playToEnd(app, 3);
    const before = await store.readSnapshot(game.gameId);
    clock.advance(10_000);
    await getExport(app, game.gameId, game.facilitatorCode, 'csv');
    await getExport(app, game.gameId, game.facilitatorCode, 'json');
    const after = await store.readSnapshot(game.gameId);
    expect(after!.game.version).toBe(before!.game.version);
    expect(after!.game.lastOperationAt).toEqual(before!.game.lastOperationAt);
  });
});
