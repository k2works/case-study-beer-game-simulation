import { describe, expect, it } from 'vitest';
import { bootGame, buildU4App, GET, json, joinWithBadCode } from '../support/harness.js';

const SECOND = 1000;

describe('US5.4 / BR18 参加の無効な試行の制限（直近 60 秒で 10 回）', () => {
  it('AC5.4.2 境界: 9 回目と 10 回目の無効な試行は 403、11 回目は 429（窓は 11 件）', async () => {
    const { app, store } = await buildU4App();
    for (let i = 1; i <= 10; i += 1) {
      const response = await joinWithBadCode(app);
      expect(response.statusCode, `${i} 回目`).toBe(403);
      expect(response.json()).toMatchObject({ kind: 'forbidden' });
    }
    expect(await store.countJoinAttempts()).toBe(10);
    const eleventh = await joinWithBadCode(app);
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.json()).toMatchObject({
      kind: 'rate_limited',
      hint: expect.stringContaining('しばらく待って'),
    });
    // 拒否された試行も窓に加わる
    expect(await store.countJoinAttempts()).toBe(11);
  });

  it('BR18.2 窓が 10 件のとき、有効なコードでも 11 回目は 429 で、参加できない', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app, { start: false });
    for (let i = 0; i < 10; i += 1) {
      await joinWithBadCode(app, '203.0.113.77');
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/games/join',
      remoteAddress: '203.0.113.77',
      payload: { joinCode: game.joinCode, displayName: '遅れた人' },
    });
    expect(response.statusCode).toBe(429);
    const view = json(await GET(app, `/api/games/${game.gameId}/state`, game.facilitatorCode));
    expect(view.participants).toHaveLength(4);
  });

  it('BR18.2 最後の試行から 60 秒が経てば、自動で解除され、有効なコードで参加できる', async () => {
    const { app, clock } = await buildU4App();
    const game = await bootGame(app, { start: false });
    for (let i = 0; i < 11; i += 1) {
      await joinWithBadCode(app, '203.0.113.78');
    }
    clock.advance(60 * SECOND);
    // ちょうど 60 秒では、まだ窓の中
    expect((await joinWithBadCode(app, '203.0.113.78')).statusCode).toBe(429);
    clock.advance(60 * SECOND + 1);
    const joined = await app.inject({
      method: 'POST',
      url: '/api/games/join',
      remoteAddress: '203.0.113.78',
      payload: { joinCode: game.joinCode, displayName: '待った人' },
    });
    expect(joined.statusCode).toBe(201);
  });

  it('BR18.2 拒否中に試行を続けると、解除が延びる', async () => {
    const { app, clock } = await buildU4App();
    for (let i = 0; i < 11; i += 1) {
      await joinWithBadCode(app, '203.0.113.79');
    }
    // 拒否されている間も試行を続ける（拒否された試行も窓に加わる）
    clock.advance(50 * SECOND);
    for (let i = 0; i < 10; i += 1) {
      expect((await joinWithBadCode(app, '203.0.113.79')).statusCode).toBe(429);
    }
    // 最初の試行から 100 秒が経っても、続けた分が窓に残っているので、まだ拒否される
    clock.advance(50 * SECOND);
    expect((await joinWithBadCode(app, '203.0.113.79')).statusCode).toBe(429);
    // 続けなくなって 60 秒が経てば、解除される
    clock.advance(61 * SECOND);
    expect((await joinWithBadCode(app, '203.0.113.79')).statusCode).toBe(403);
  });

  it('BR18.1 有効な参加は数えない（同じ接続元から何度でも参加できる）', async () => {
    const { app, store } = await buildU4App();
    const game = await bootGame(app, { start: false });
    for (let i = 0; i < 12; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/games/join',
        remoteAddress: '203.0.113.80',
        payload: { joinCode: game.joinCode, displayName: `参加者 ${i}` },
      });
      expect(response.statusCode, `${i + 1} 回目`).toBe(201);
    }
    expect(await store.countJoinAttempts()).toBe(0);
  });

  it('BR18.1 形式が不正な本文（コードの欠落）は 422 で、窓に数えない', async () => {
    const { app, store } = await buildU4App();
    for (let i = 0; i < 15; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/games/join',
        remoteAddress: '203.0.113.81',
        payload: { displayName: 'コードなし' },
      });
      expect(response.statusCode).toBe(422);
    }
    expect(await store.countJoinAttempts()).toBe(0);
    expect((await joinWithBadCode(app, '203.0.113.81')).statusCode).toBe(403);
  });

  it('接続元ごとに数える。ある接続元の制限は、ほかの接続元に影響しない', async () => {
    const { app } = await buildU4App();
    const game = await bootGame(app, { start: false });
    for (let i = 0; i < 11; i += 1) {
      await joinWithBadCode(app, '203.0.113.82');
    }
    expect((await joinWithBadCode(app, '203.0.113.82')).statusCode).toBe(429);
    const other = await app.inject({
      method: 'POST',
      url: '/api/games/join',
      remoteAddress: '203.0.113.83',
      payload: { joinCode: game.joinCode, displayName: '別の接続元' },
    });
    expect(other.statusCode).toBe(201);
  });

  it('NFR6.6 同じ /64 の IPv6 アドレスを変えても、窓は共有される', async () => {
    const { app } = await buildU4App();
    for (let i = 1; i <= 10; i += 1) {
      expect((await joinWithBadCode(app, `2001:db8:aaaa:bbbb::${i}`)).statusCode).toBe(403);
    }
    expect((await joinWithBadCode(app, '2001:db8:aaaa:bbbb:ffff::1')).statusCode).toBe(429);
    // 別の /64 は別の接続元
    expect((await joinWithBadCode(app, '2001:db8:aaaa:bbbc::1')).statusCode).toBe(403);
  });

  it('NFR6.6 IPv4 射影アドレスは IPv4 と同じ接続元として数える', async () => {
    const { app } = await buildU4App();
    for (let i = 0; i < 5; i += 1) {
      await joinWithBadCode(app, '203.0.113.90');
      await joinWithBadCode(app, '::ffff:203.0.113.90');
    }
    expect((await joinWithBadCode(app, '203.0.113.90')).statusCode).toBe(429);
  });

  it('BR18.3 プロキシを信頼しない設定では、利用者が付けた転送元のヘッダで窓を回避できない', async () => {
    const { app } = await buildU4App();
    for (let i = 0; i < 10; i += 1) {
      const response = await joinWithBadCode(app, '203.0.113.91', {
        'x-forwarded-for': `10.9.9.${i}`,
      });
      expect(response.statusCode).toBe(403);
    }
    const forged = await joinWithBadCode(app, '203.0.113.91', { 'x-forwarded-for': '10.9.9.200' });
    expect(forged.statusCode).toBe(429);
  });

  it('BR18.3 信頼するプロキシが 1 段の設定では、プロキシが付けた接続元で数え、先頭に足した偽の値では回避できない', async () => {
    const { app } = await buildU4App({ trustedProxyHops: 1 });
    // 実際の接続元は 203.0.113.50（プロキシが末尾に足す）。利用者は先頭に偽の値を足せる
    for (let i = 0; i < 10; i += 1) {
      const response = await joinWithBadCode(app, '10.0.0.1', {
        'x-forwarded-for': `1.1.1.${i}, 203.0.113.50`,
      });
      expect(response.statusCode).toBe(403);
    }
    const forged = await joinWithBadCode(app, '10.0.0.1', {
      'x-forwarded-for': '9.9.9.9, 203.0.113.50',
    });
    expect(forged.statusCode).toBe(429);
    // 別の実際の接続元は影響を受けない（全員が 1 つの接続元にならない）
    const other = await joinWithBadCode(app, '10.0.0.1', { 'x-forwarded-for': '203.0.113.51' });
    expect(other.statusCode).toBe(403);
  });

  it('接続元は窓の保存先にも応答にも生のアドレスとして出ない', async () => {
    const { app, logs } = await buildU4App();
    const response = await joinWithBadCode(app, '203.0.113.99');
    expect(response.body).not.toContain('203.0.113.99');
    expect(JSON.stringify(logs)).not.toContain('203.0.113.99');
  });

  it('既定の数値は設定で変えられる（窓の件数と長さ）', async () => {
    const { app, clock } = await buildU4App({
      policy: { joinMaxAttempts: 2, joinWindowMs: 10 * SECOND },
    });
    expect((await joinWithBadCode(app, '203.0.113.100')).statusCode).toBe(403);
    expect((await joinWithBadCode(app, '203.0.113.100')).statusCode).toBe(403);
    expect((await joinWithBadCode(app, '203.0.113.100')).statusCode).toBe(429);
    clock.advance(10 * SECOND + 1);
    expect((await joinWithBadCode(app, '203.0.113.100')).statusCode).toBe(403);
  });
});
