import { describe, expect, it } from 'vitest';
import { FailureMemory } from '../../../src/server/retention/failure-memory.js';
import { RETENTION_LOCK_KEY, RetentionJob } from '../../../src/server/retention/job.js';
import type { MemoryStore } from '../../../src/server/session/memory-store.js';
import { expectProblem } from '../../u3/support/helpers.js';
import { newKey } from '../../u1/support/world.js';
import {
  DAY_MS,
  buildRig,
  buildU4App,
  endedEarly,
  finishedGame,
  GET,
  playedGame,
  type Rig,
} from '../support/harness.js';

const MINUTE = 60_000;

/** 削除の対象として選べるよう、終了から日数を進める。 */
const age = (rig: Rig, days: number): void => rig.world.clock.advance(days * DAY_MS);

const exists = async (rig: Rig, gameId: string): Promise<boolean> =>
  (await rig.store.readSnapshot(gameId)) !== null;

describe('US5.1 AC5.1.1 保持期間を設定していないゲームは、終了から 31 日後に削除され、参加コードは無効になる', () => {
  it('Given 終了から 31 日が経ったゲーム / When 削除の処理が動く / Then ゲームのデータは削除され、参加コードは無効になる', async () => {
    const rig = buildRig();
    const game = await finishedGame(rig.world, 3);
    age(rig, 31);

    const result = await rig.job.runOnce();

    expect(result).toMatchObject({ autoEnded: 0, deleted: 1, failed: 0, skipped: false });
    expect(await exists(rig, game.gameId)).toBe(false);
    expect(await rig.store.readHistory(game.gameId)).toEqual([]);
    expect(await rig.store.getAccessCode(game.gameId, 'join')).toBeNull();
    await expectProblem(
      rig.world.session.joinGame({ joinCode: game.joinCode, displayName: '遅れた人' }),
      'forbidden',
    );
  });

  it('BR24.4 削除したゲームへの要求は、存在しないゲームと同じ 403 の本文で拒否される', async () => {
    const rig = buildRig();
    const game = await finishedGame(rig.world, 3);
    const { app } = await buildU4App({ store: rig.store, clock: rig.world.clock });
    const noCredential = await GET(app, `/api/games/${game.gameId}/state`);
    const beforeDeletion = await GET(app, `/api/games/${game.gameId}/state`, game.facilitatorCode);
    expect(beforeDeletion.statusCode).toBe(200);

    age(rig, 31);
    await rig.job.runOnce();

    for (const credential of [
      game.facilitatorCode,
      game.observerCode,
      game.players.retailer.token,
    ]) {
      for (const url of ['state', 'results']) {
        const response = await GET(app, `/api/games/${game.gameId}/${url}`, credential);
        expect(response.statusCode, `${url}`).toBe(403);
        expect(response.json()).toEqual(noCredential.json());
      }
    }
  });

  it('BR24.2 期限の境界: 直前は対象外、ちょうどと直後は対象', async () => {
    const rig = buildRig();
    const game = await finishedGame(rig.world, 3);
    rig.world.clock.advance(30 * DAY_MS - 1);
    expect(await rig.job.runOnce()).toMatchObject({ deleted: 0 });
    expect(await exists(rig, game.gameId)).toBe(true);

    rig.world.clock.advance(1);
    expect(await rig.job.runOnce()).toMatchObject({ deleted: 1 });
    expect(await exists(rig, game.gameId)).toBe(false);
  });

  it('BR24.7 終了していないゲームは、保持期間を過ぎても削除しない（先に自動終了する）', async () => {
    const rig = buildRig({ policy: { autoEndDays: 3650 } });
    const running = await playedGame(rig.world, { weekCount: 5, confirmWeeks: 1 });
    age(rig, 400);
    const result = await rig.job.runOnce();
    expect(result).toMatchObject({ autoEnded: 0, deleted: 0 });
    expect(await exists(rig, running.gameId)).toBe(true);
  });

  it('BR24.3 削除は、ゲームに紐づくすべてのデータをまとめて消し、ほかのゲームは残す', async () => {
    const rig = buildRig();
    const doomed = await endedEarly(rig.world, 2, 5);
    age(rig, 20);
    const keeper = await finishedGame(rig.world, 3);
    age(rig, 11);
    await rig.job.runOnce();
    expect(await exists(rig, doomed.gameId)).toBe(false);
    expect(await exists(rig, keeper.gameId)).toBe(true);
    expect((await rig.store.readSnapshot(keeper.gameId))!.weekRecords.length).toBeGreaterThan(0);
  });

  it('BR24.3 削除の保存が途中で失敗したら、何も消えず、失敗に数えて次の周期でやり直す', async () => {
    const rig = buildRig();
    const game = await finishedGame(rig.world, 3);
    age(rig, 31);
    (rig.store as MemoryStore).failNextWriteOn = 'deleteGame';

    const failed = await rig.job.runOnce();
    expect(failed).toMatchObject({ deleted: 0, failed: 1 });
    const intact = await rig.store.readSnapshot(game.gameId);
    expect(intact!.weekRecords.length).toBe(12);
    expect(intact!.participants.length).toBe(4);
    expect(await rig.store.getAccessCode(game.gameId, 'join')).not.toBeNull();

    // 失敗から 1 周期のあいだは選ばない。1 周期たてば、また対象に戻って削除される
    expect(await rig.job.runOnce()).toMatchObject({ deleted: 0, failed: 0 });
    rig.world.clock.advance(61 * MINUTE);
    expect(await rig.job.runOnce()).toMatchObject({ deleted: 1, failed: 0 });
    expect(await exists(rig, game.gameId)).toBe(false);
  });
});

describe('US5.1 AC5.1.2 保持期間を 7 日に設定したとき、終了から 8 日で削除される', () => {
  it('Given 保持期間 7 日 / When 終了から 8 日が経つ / Then 設定の期間に従って削除される', async () => {
    const rig = buildRig({ policy: { retentionDays: 7 } });
    const game = await finishedGame(rig.world, 3);
    age(rig, 6);
    expect(await rig.job.runOnce()).toMatchObject({ deleted: 0 });
    age(rig, 2);
    expect(await rig.job.runOnce()).toMatchObject({ deleted: 1 });
    expect(await exists(rig, game.gameId)).toBe(false);
  });

  it('BR24.2 設定を短くすると、すでに終了したゲームにも次の処理から適用される（ゲームに期間を記録しない）', async () => {
    const rig = buildRig();
    const game = await finishedGame(rig.world, 3);
    age(rig, 8);
    expect(await rig.job.runOnce()).toMatchObject({ deleted: 0 });

    const shorter = new RetentionJob({
      store: rig.store,
      session: rig.world.session,
      clock: rig.world.clock,
      policy: { ...rig.policy, retentionDays: 7 },
      log: () => undefined,
    });
    expect(await shorter.runOnce()).toMatchObject({ deleted: 1 });
    expect(await exists(rig, game.gameId)).toBe(false);
  });
});

describe('US5.1 AC5.1.3 最後の操作から 30 日、終了していないゲームは自動終了し、その時点から保持期間を数える', () => {
  it('Given 進行中のゲームで最後の操作から 30 日 / When 自動終了の処理が動く / Then 終了し、理由は autoEnd、履歴は system', async () => {
    const rig = buildRig();
    const game = await playedGame(rig.world, { weekCount: 5, confirmWeeks: 1 });
    age(rig, 30);

    const result = await rig.job.runOnce();

    expect(result).toMatchObject({ autoEnded: 1, deleted: 0, failed: 0 });
    const snapshot = await rig.store.readSnapshot(game.gameId);
    expect(snapshot!.game).toMatchObject({ status: 'ended', endReason: 'autoEnd' });
    expect(snapshot!.game.endedAt).toEqual(rig.world.clock.now());
    const history = await rig.world.session.getHistory(game.facilitator, game.gameId);
    expect(history.entries.at(-1)).toMatchObject({
      kind: 'end',
      actorKind: 'system',
      detail: { reason: 'autoEnd' },
    });
    // 終了後は、確定の操作を拒否する
    await expectProblem(
      rig.world.session.confirmWeek(game.facilitator, game.gameId, 2, newKey('after-auto-end')),
      'state',
    );
  });

  it('BR25.5 自動終了と同じ周期では削除しない。終了の時刻から保持期間を数え、その日に削除される', async () => {
    const rig = buildRig({ policy: { retentionDays: 1, autoEndDays: 1 } });
    const game = await playedGame(rig.world, { weekCount: 5, confirmWeeks: 1 });
    age(rig, 5);
    expect(await rig.job.runOnce()).toMatchObject({ autoEnded: 1, deleted: 0 });
    expect(await rig.job.runOnce()).toMatchObject({ autoEnded: 0, deleted: 0 });
    expect(await exists(rig, game.gameId)).toBe(true);
    age(rig, 1);
    expect(await rig.job.runOnce()).toMatchObject({ autoEnded: 0, deleted: 1 });
  });

  it('BR25.1 準備中と一時停止中のゲームも、最後の操作から 30 日で自動終了する', async () => {
    const rig = buildRig();
    const preparing = await rig.world.createGame();
    const paused = await rig.world.startedGame({ weekCount: 5 });
    await rig.world.session.pauseGame(paused.facilitator, paused.gameId);
    age(rig, 30);
    const result = await rig.job.runOnce();
    expect(result).toMatchObject({ autoEnded: 2, failed: 0 });
    for (const id of [preparing.gameId, paused.gameId]) {
      expect((await rig.store.readSnapshot(id))!.game).toMatchObject({
        status: 'ended',
        endReason: 'autoEnd',
      });
    }
  });

  it('BR25.1 期限の境界: 29 日 23 時間 59 分は対象外、30 日ちょうどは対象', async () => {
    const rig = buildRig();
    const game = await rig.world.createGame();
    rig.world.clock.advance(30 * DAY_MS - 1);
    expect(await rig.job.runOnce()).toMatchObject({ autoEnded: 0 });
    rig.world.clock.advance(1);
    expect(await rig.job.runOnce()).toMatchObject({ autoEnded: 1 });
    expect((await rig.store.readSnapshot(game.gameId))!.game.status).toBe('ended');
  });

  it('BR25.2 最後の操作があれば期限は延びる: 29 日目の入力のあと、31 日目では終了しない', async () => {
    const rig = buildRig();
    const game = await rig.world.startedGame({ weekCount: 5 });
    age(rig, 29);
    await rig.world.session.submitDecision(
      game.players.retailer.principal,
      game.gameId,
      1,
      'retailer',
      { quantity: 4 },
      newKey('keep-alive'),
    );
    age(rig, 2);
    expect(await rig.job.runOnce()).toMatchObject({ autoEnded: 0 });
    age(rig, 29);
    expect(await rig.job.runOnce()).toMatchObject({ autoEnded: 1 });
  });

  it('BR25.2 閲覧だけでは期限は延びない', async () => {
    const rig = buildRig();
    const game = await rig.world.startedGame({ weekCount: 5 });
    age(rig, 29);
    await rig.world.session.getState(game.facilitator, game.gameId);
    age(rig, 1);
    expect(await rig.job.runOnce()).toMatchObject({ autoEnded: 1 });
  });
});

describe('BR25.4 BR24.5 占有の中の再検査と、結果の区別', () => {
  it('autoEnd: 選んだあとに操作があれば not-stale、終了済みは already-ended、無ければ not-found', async () => {
    const rig = buildRig();
    const game = await rig.world.startedGame({ weekCount: 5 });
    const now = rig.world.clock.now();
    const staleBefore = new Date(now.getTime() - 30 * DAY_MS);
    // 操作が期限の境界より新しい（選んだあとに操作があった状態）
    expect(await rig.world.session.autoEnd(game.gameId, staleBefore)).toBe('not-stale');
    expect((await rig.store.readSnapshot(game.gameId))!.game.status).toBe('running');

    expect(await rig.world.session.autoEnd(game.gameId, now)).toBe('ended');
    expect(await rig.world.session.autoEnd(game.gameId, now)).toBe('already-ended');
    expect(await rig.world.session.autoEnd('99999999-9999-4999-8999-999999999999', now)).toBe(
      'not-found',
    );
  });

  it('deleteIfExpired: 期限前や進行中は not-expired、期限後の終了済みは deleted、再度は not-found（冪等）', async () => {
    const rig = buildRig();
    const running = await rig.world.startedGame({ weekCount: 5 });
    const ended = await finishedGame(rig.world, 3);
    const far = new Date(rig.world.clock.now().getTime() + 1000 * DAY_MS);
    expect(await rig.world.session.deleteIfExpired(running.gameId, far)).toBe('not-expired');
    const past = new Date(rig.world.clock.now().getTime() - 30 * DAY_MS);
    expect(await rig.world.session.deleteIfExpired(ended.gameId, past)).toBe('not-expired');
    expect(await rig.world.session.deleteIfExpired(ended.gameId, rig.world.clock.now())).toBe(
      'deleted',
    );
    expect(await rig.world.session.deleteIfExpired(ended.gameId, rig.world.clock.now())).toBe(
      'not-found',
    );
    expect(await exists(rig, running.gameId)).toBe(true);
  });
});

describe('BR26.2 BR26.3 BR26.4 定期処理の排他、順序と上限、失敗の隔離', () => {
  it('BR26.2 すでに実行中（ロックを取れない）なら、何もせず skipped を返す', async () => {
    const rig = buildRig();
    const game = await finishedGame(rig.world, 3);
    age(rig, 31);
    const held = await rig.store.runExclusive(RETENTION_LOCK_KEY, () => rig.job.runOnce());
    expect(held).toEqual({
      acquired: true,
      value: expect.objectContaining({ skipped: true, deleted: 0, autoEnded: 0 }),
    });
    expect(await exists(rig, game.gameId)).toBe(true);
    expect(rig.logs.find((line) => line.event === 'retention_run')).toMatchObject({
      skipped: true,
      level: 'info',
    });
  });

  it('BR26.3 1 回の上限は古い順に扱い、残りは次の周期で扱う', async () => {
    const rig = buildRig({ policy: { batchLimit: 2 } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await finishedGame(rig.world, 3)).gameId);
      rig.world.clock.advance(MINUTE);
    }
    age(rig, 31);
    expect(await rig.job.runOnce()).toMatchObject({ deleted: 2 });
    expect(await exists(rig, ids[0]!)).toBe(false);
    expect(await exists(rig, ids[1]!)).toBe(false);
    expect(await exists(rig, ids[2]!)).toBe(true);
    expect(await rig.job.runOnce()).toMatchObject({ deleted: 1 });
    expect(await exists(rig, ids[2]!)).toBe(false);
  });

  it('BR26.4 BR26.3 失敗するゲームが上限と同じ数あっても、後ろの正常なゲームは 2 回の処理のうちに処理される', async () => {
    const rig = buildRig({ policy: { batchLimit: 2 } });
    const bad = new Set<string>();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push((await finishedGame(rig.world, 3)).gameId);
      rig.world.clock.advance(MINUTE);
    }
    bad.add(ids[0]!);
    bad.add(ids[1]!);
    age(rig, 31);
    const job = new RetentionJob({
      store: rig.store,
      session: {
        autoEnd: (id, before) => rig.world.session.autoEnd(id, before),
        deleteIfExpired: async (id, before) => {
          if (bad.has(id)) {
            throw new Error('保存の失敗: 太郎さんのゲーム');
          }
          return rig.world.session.deleteIfExpired(id, before);
        },
      },
      clock: rig.world.clock,
      policy: rig.policy,
      log: (line) => rig.logs.push(line),
      failures: new FailureMemory({ cooldownMs: 60 * MINUTE }),
    });

    expect(await job.runOnce()).toMatchObject({ deleted: 0, failed: 2 });
    expect(await job.runOnce()).toMatchObject({ deleted: 2, failed: 0 });
    expect(await exists(rig, ids[2]!)).toBe(false);
    expect(await exists(rig, ids[3]!)).toBe(false);
    expect(await exists(rig, ids[0]!)).toBe(true);
    // 失敗は種類だけをログに出し、メッセージ（個人の情報を含みうる）は出さない
    const failures = rig.logs.filter((line) => line.event === 'game_retention_failed');
    expect(failures).toHaveLength(2);
    expect(JSON.stringify(failures)).not.toContain('太郎');
    expect(failures[0]).toMatchObject({ operation: 'delete', errorName: 'Error' });
  });

  it('BR26.4 自動終了の失敗も、ほかのゲームを止めない', async () => {
    const rig = buildRig();
    const a = await rig.world.createGame();
    rig.world.clock.advance(MINUTE);
    const b = await rig.world.createGame();
    age(rig, 31);
    (rig.store as MemoryStore).failNextWriteOn = 'updateGame';
    const result = await rig.job.runOnce();
    expect(result).toMatchObject({ autoEnded: 1, failed: 1 });
    const statuses = [
      (await rig.store.readSnapshot(a.gameId))!.game.status,
      (await rig.store.readSnapshot(b.gameId))!.game.status,
    ];
    expect(statuses.sort()).toEqual(['ended', 'preparing']);
  });

  it('BR24.6 ログにはゲームの識別子、時刻、理由だけを出し、表示名・ゲーム名・コード・token を含めない', async () => {
    const rig = buildRig();
    const ended = await finishedGame(rig.world, 3);
    const stale = await rig.world.startedGame({ weekCount: 5 });
    age(rig, 31);
    await rig.job.runOnce();
    const deleted = rig.logs.find((line) => line.event === 'game_deleted');
    expect(deleted).toBeDefined();
    expect(Object.keys(deleted!).sort()).toEqual([
      'deletedAt',
      'event',
      'gameId',
      'level',
      'reason',
      'time',
    ]);
    expect(deleted).toMatchObject({ gameId: ended.gameId, reason: 'retentionExpired' });
    expect(deleted!.deletedAt).toBe(rig.world.clock.now().toISOString());
    const autoEnded = rig.logs.find((line) => line.event === 'game_auto_ended');
    expect(Object.keys(autoEnded!).sort()).toEqual([
      'at',
      'event',
      'gameId',
      'level',
      'reason',
      'time',
    ]);
    expect(autoEnded).toMatchObject({ gameId: stale.gameId, reason: 'autoEnd' });

    const text = JSON.stringify(rig.logs);
    for (const secret of [
      ended.joinCode,
      ended.facilitatorCode,
      ended.observerCode,
      ended.players.retailer.token,
      '小売店',
      '試験のゲーム',
    ]) {
      expect(text).not.toContain(secret);
    }
    const summary = rig.logs.find((line) => line.event === 'retention_run');
    expect(summary).toMatchObject({ autoEnded: 1, deleted: 1, failed: 0, skipped: false });
    expect(typeof summary!.durationMs).toBe('number');
    expect(typeof summary!.startedAt).toBe('string');
  });

  it('runOnce は時刻を指定して直接呼べる（時計に依存しない）', async () => {
    const rig = buildRig();
    const game = await finishedGame(rig.world, 3);
    const future = new Date(rig.world.clock.now().getTime() + 45 * DAY_MS);
    expect(await rig.job.runOnce(future)).toMatchObject({ deleted: 1 });
    expect(await exists(rig, game.gameId)).toBe(false);
  });
});
