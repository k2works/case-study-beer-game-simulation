import { describe, expect, it } from 'vitest';
import { bearer, bootGame, buildU4App, GET, json, joinWithBadCode } from '../support/harness.js';
import { newKey } from '../../u1/support/world.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const stateUrl = (gameId: string) => `/api/games/${gameId}/state`;

describe('US3.2 参加者が切断後に同じ役割へ戻る', () => {
  it('AC3.2.1 / AC3.2.2 Given 30 分切断された / When 同じ token で再接続 / Then 同じ参加者・同じ役割で、確定済みと未確定の入力が残る', async () => {
    const { app, clock } = await buildU4App();
    const game = await bootGame(app);
    const retailer = game.players.retailer;
    await app.inject({
      method: 'PUT',
      url: `/api/games/${game.gameId}/weeks/1/decisions/retailer`,
      headers: { ...bearer(retailer.token), 'idempotency-key': newKey('recover') },
      payload: { quantity: 10 },
    });

    clock.advance(30 * MINUTE);
    const response = await GET(app, stateUrl(game.gameId), retailer.token);
    expect(response.statusCode).toBe(200);
    const view = json(response);
    expect(view.role).toBe('retailer');
    expect(view.self.participantId).toBe(retailer.participantId);
    expect(view.mine.decision).toBe(10);
  });

  it('BR17.5 再接続しても token は作り直さず、同じ token を複数のタブで使える', async () => {
    const { app, clock } = await buildU4App();
    const game = await bootGame(app);
    const token = game.players.factory.token;
    clock.advance(5 * MINUTE);
    const [first, second] = await Promise.all([
      GET(app, stateUrl(game.gameId), token),
      GET(app, stateUrl(game.gameId), token),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.body).not.toContain('tok_');
    expect(json(first).self.participantId).toBe(json(second).self.participantId);
    expect((await GET(app, '/api/me', token)).statusCode).toBe(200);
  });

  it('AC3.2.3 Given 最後の操作から 24 時間を超えた token / When 再接続 / Then 拒否される', async () => {
    const { app, clock } = await buildU4App();
    const game = await bootGame(app);
    const token = game.players.wholesaler1.token;
    clock.advance(24 * HOUR - MINUTE);
    expect((await GET(app, stateUrl(game.gameId), token)).statusCode).toBe(200);
    // この要求は 1 分以上あとなので lastUsedAt が延びる。延ばさないものは別の試験で確かめる
  });

  it('AC3.2.3 最後の操作から 24 時間 + 1 分を過ぎた token は 403', async () => {
    const { app, clock } = await buildU4App();
    const game = await bootGame(app);
    const token = game.players.wholesaler2.token;
    clock.advance(24 * HOUR + MINUTE);
    const response = await GET(app, stateUrl(game.gameId), token);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ kind: 'forbidden' });
  });

  it('BR17.2 要求のたびに最後の操作が延びる。使い続ける限り、24 時間を超えても有効', async () => {
    const { app, clock } = await buildU4App();
    const game = await bootGame(app);
    const token = game.players.factory.token;
    for (let i = 0; i < 4; i += 1) {
      clock.advance(23 * HOUR);
      const response = await GET(app, stateUrl(game.gameId), token);
      expect(response.statusCode, `${i + 1} 回目`).toBe(200);
      await app.whenIdle();
    }
  });

  it('BR17.2 書き込みは 1 分に 1 回まで。1 分未満の要求では最後の操作を延ばさない', async () => {
    const { app, clock } = await buildU4App();
    const game = await bootGame(app);
    const token = game.players.retailer.token;
    clock.advance(30 * 1000);
    expect((await GET(app, stateUrl(game.gameId), token)).statusCode).toBe(200);
    await app.whenIdle();
    // 延びていないので、発行から 24 時間 + 10 秒で期限切れ
    clock.advance(24 * HOUR - 30 * 1000 + 10 * 1000);
    expect((await GET(app, stateUrl(game.gameId), token)).statusCode).toBe(403);
  });

  it('BR17.2 1 分以上あとの要求では延びる（発行から 24 時間 + 10 秒でも有効）', async () => {
    const { app, clock } = await buildU4App();
    const game = await bootGame(app);
    const token = game.players.retailer.token;
    clock.advance(61 * 1000);
    expect((await GET(app, stateUrl(game.gameId), token)).statusCode).toBe(200);
    await app.whenIdle();
    clock.advance(24 * HOUR - 61 * 1000 + 10 * 1000);
    expect((await GET(app, stateUrl(game.gameId), token)).statusCode).toBe(200);
  });

  it('BR17.2 lastUsedAt の書き込みが失敗しても、要求は拒否せず、warn のログに出す', async () => {
    const { app, store, logs, clock } = await buildU4App();
    const game = await bootGame(app);
    const failing = store as unknown as { touchToken: () => Promise<boolean> };
    failing.touchToken = async () => {
      throw new Error('書き込みの失敗');
    };
    clock.advance(2 * MINUTE);
    const response = await GET(app, stateUrl(game.gameId), game.players.factory.token);
    await app.whenIdle();
    expect(response.statusCode).toBe(200);
    const warn = logs.find((line) => line.event === 'last_used_update_failed');
    expect(warn).toMatchObject({ level: 'warn', errorName: 'Error' });
  });

  it('AC3.2.4 Given token を失った / When 進行役が入れ替える / Then 新しい token で同じ役割に戻れ、旧 token は使えない', async () => {
    const { app, clock } = await buildU4App();
    const game = await bootGame(app);
    clock.advance(20 * HOUR);
    const replaced = json(
      await app.inject({
        method: 'POST',
        url: `/api/games/${game.gameId}/roles/retailer/replacement`,
        headers: game.facilitator,
        payload: { participantId: game.players.retailer.participantId, displayName: '戻る人' },
      }),
    );
    expect((await GET(app, stateUrl(game.gameId), game.players.retailer.token)).statusCode).toBe(
      403,
    );

    // 新しい token は発行の時刻から数える（BR17.6）
    clock.advance(23 * HOUR);
    const back = await GET(app, stateUrl(game.gameId), replaced.token);
    expect(back.statusCode).toBe(200);
    expect(json(back).role).toBe('retailer');
  });
});

describe('BR17.3 / NFR6.4 無効な token は理由を区別せず、同じ応答', () => {
  it('不明、失効、期限切れの 3 つの応答が、状態コード・本文・ヘッダまで一致する', async () => {
    const { app, clock } = await buildU4App();
    const game = await bootGame(app);

    const unknown = await GET(app, stateUrl(game.gameId), 'tok_unknown-unknown-unknown-unknown');

    await app.inject({
      method: 'POST',
      url: `/api/games/${game.gameId}/roles/factory/replacement`,
      headers: game.facilitator,
      payload: { participantId: game.players.factory.participantId, displayName: '交代' },
    });
    const revoked = await GET(app, stateUrl(game.gameId), game.players.factory.token);

    clock.advance(24 * HOUR + MINUTE);
    const expired = await GET(app, stateUrl(game.gameId), game.players.wholesaler1.token);

    const shape = (response: typeof unknown) => {
      // 要求ごとに変わる項目（要求の識別子と日時）は比べない
      const headers = Object.fromEntries(
        Object.entries(response.headers).filter(
          ([key]) => key !== 'x-request-id' && key !== 'date',
        ),
      );
      return { status: response.statusCode, body: response.body, headers };
    };
    expect(unknown.statusCode).toBe(403);
    expect(shape(revoked)).toEqual(shape(unknown));
    expect(shape(expired)).toEqual(shape(unknown));
    // 本文は、種類（参加者・観察者・進行役）を含まない 1 つの形
    expect(unknown.json()).toEqual({
      kind: 'forbidden',
      reason: expect.any(String),
      hint: expect.any(String),
    });
  });

  it('期限切れの token の拒否は行を変えない（ログだけが残り、履歴には書かれない）', async () => {
    const { app, clock } = await buildU4App();
    const game = await bootGame(app);
    const before = json(
      await app.inject({
        method: 'GET',
        url: `/api/games/${game.gameId}/history`,
        headers: game.facilitator,
      }),
    );
    clock.advance(24 * HOUR + MINUTE);
    await GET(app, stateUrl(game.gameId), game.players.factory.token);
    await GET(app, stateUrl(game.gameId), 'tok_unknown-unknown-unknown-unknown');
    const after = json(
      await app.inject({
        method: 'GET',
        url: `/api/games/${game.gameId}/history`,
        headers: bearer(game.facilitatorCode),
      }),
    );
    expect(after.entries.length).toBe(before.entries.length);
  });
});

describe('NFR9.1 / NFR9.2 拒否の分類、ログ、件数', () => {
  it('無効な資格情報は invalid_token、参加コードの無効な試行は invalid_code、制限は rate_limited として数える', async () => {
    const { app, logs } = await buildU4App();
    const game = await bootGame(app);
    const secret = 'tok_secret-value-that-must-not-appear-in-logs';
    await GET(app, stateUrl(game.gameId), secret);
    await joinWithBadCode(app, '198.51.100.9');
    for (let i = 0; i < 10; i += 1) {
      await joinWithBadCode(app, '198.51.100.9');
    }
    expect(app.rejectionCounts()).toEqual({ invalid_token: 1, invalid_code: 10, rate_limited: 1 });

    const kinds = logs.map((line) => line.rejection).filter(Boolean);
    expect(kinds.filter((k) => k === 'invalid_token')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'invalid_code')).toHaveLength(10);
    expect(kinds.filter((k) => k === 'rate_limited')).toHaveLength(1);

    // 資格情報の文字列は、どのログにも出ない
    const text = JSON.stringify(logs);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('WRONGCODE2');
    // 接続元は鍵付きの要約として出る（生の接続元は出ない）
    expect(text).not.toContain('198.51.100.9');
    const limited = logs.find((line) => line.rejection === 'rate_limited');
    expect(limited?.src).toEqual(expect.any(String));
  });

  it('資格情報が有効でも権限のない要求（403）は、既存の結果の種類で出し、invalid_token には数えない', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/games/${game.gameId}/pause`,
      headers: bearer(game.players.factory.token),
    });
    expect(response.statusCode).toBe(403);
    expect(app.rejectionCounts().invalid_token).toBe(0);
  });
});
