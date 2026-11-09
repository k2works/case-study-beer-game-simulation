import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('Given keyboard access When a facilitator creates a game Then the join code is focused and the lobby remains usable at 200% zoom', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto('/');
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('function');
  await expect(page.getByRole('link', { name: '本文へスキップ' })).toHaveAttribute('href', '#main');
  await page.getByRole('button', { name: 'ゲームを作る' }).click();
  const createResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/games'),
  );
  await page.getByRole('button', { name: 'ゲームを作成' }).click();
  const response = await createResponse;
  expect(response.status(), await response.text()).toBe(201);
  const code = page.locator('strong[tabindex="-1"]');
  await expect(code).toBeFocused();
  await expect(code).toHaveText(/^[A-Z0-9]{8}$/);
  await page.getByRole('button', { name: 'ロビーへ' }).click();
  await expect(page.getByRole('heading', { name: 'ロビー' })).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.zoom = '200%';
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('Given an invitation When a participant joins Then the lobby hides facilitator controls', async ({
  browser,
}) => {
  const facilitator = await browser.newContext();
  const participant = await browser.newContext();
  try {
    const host = await facilitator.newPage();
    await host.goto('/');
    await host.getByRole('button', { name: 'ゲームを作る' }).click();
    await host.getByRole('button', { name: 'ゲームを作成' }).click();
    const code = (await host.locator('strong[tabindex="-1"]').textContent())?.trim() ?? '';
    const player = await participant.newPage();
    await player.goto('/');
    await player.getByRole('button', { name: 'ゲームに参加・復帰' }).click();
    await player.getByLabel('参加コード').fill(code);
    await player.getByLabel('表示名').fill('参加者');
    await player.getByRole('button', { name: '参加する' }).click();
    await expect(player.getByRole('heading', { name: 'ロビー' })).toBeVisible();
    await expect(player.getByText(code)).toHaveCount(0);
    await expect(player.getByRole('button', { name: '開始する' })).toHaveCount(0);
  } finally {
    await facilitator.close();
    await participant.close();
  }
});

test('Given a role-safe session When SSE fails Then a recovered participant sees only own state with polling fallback', async ({
  browser,
}, testInfo) => {
  const origin = 'http://127.0.0.1:3100';
  const host = await browser.newContext();
  const participants = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
  try {
    let recoveryToken: string | undefined;
    let sessionToken: string | undefined;
    const created = await host.request.post(`${origin}/api/v1/games`, {
      headers: { Origin: origin, 'Idempotency-Key': `e2e-role-create-${randomUUID()}` },
      data: { finalWeek: 1, demand: [4] },
    });
    expect(created.status()).toBe(201);
    const game = (await created.json()) as { gameId: string; sessionId: string };
    const roles = ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'];
    for (let index = 0; index < roles.length; index++) {
      const joined = await participants[index].request.post(
        `${origin}/api/v1/games/${game.gameId}/participants`,
        {
          headers: { Origin: origin, 'Idempotency-Key': `e2e-join-${game.gameId}-${index}` },
          data: { displayName: `P${index}` },
        },
      );
      expect(joined.status()).toBe(201);
      if (index === 0) {
        recoveryToken = joined
          .headersArray()
          .find(
            (header) =>
              header.name.toLowerCase() === 'set-cookie' && header.value.startsWith('bg_recovery='),
          )
          ?.value.match(/^bg_recovery=([^;]+)/)?.[1];
        sessionToken = joined
          .headersArray()
          .find(
            (header) =>
              header.name.toLowerCase() === 'set-cookie' && header.value.startsWith('bg_session='),
          )
          ?.value.match(/^bg_session=([^;]+)/)?.[1];
      }
      const participantId = ((await joined.json()) as { participantId: string }).participantId;
      const assigned = await host.request.put(
        `${origin}/api/v1/games/${game.gameId}/participants/${participantId}/role`,
        {
          headers: {
            Origin: origin,
            'Idempotency-Key': `e2e-role-${game.gameId}-${index}`,
            'If-Match': '1',
          },
          data: { role: roles[index] },
        },
      );
      expect(assigned.status()).toBe(200);
    }
    const started = await host.request.post(`${origin}/api/v1/sessions/${game.sessionId}/start`, {
      headers: { Origin: origin, 'Idempotency-Key': `e2e-start-${game.gameId}`, 'If-Match': '1' },
    });
    expect(started.status()).toBe(200);
    if (testInfo.project.name === 'webkit') {
      // WebKit rejects Secure cookies on the HTTP-only local fixture; production uses HTTPS.
      expect(recoveryToken).toBeDefined();
      expect(sessionToken).toBeDefined();
      await participants[0].addCookies([
        {
          name: 'bg_recovery',
          value: recoveryToken!,
          domain: '127.0.0.1',
          path: '/api/v1/participations/recover',
          httpOnly: true,
          secure: false,
          sameSite: 'Strict',
        },
        {
          name: 'bg_session',
          value: sessionToken!,
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Strict',
        },
      ]);
    }
    const player = await participants[0].newPage();
    await player.route('**/api/v1/games/*/events', (route) => route.abort());
    await player.goto('/');
    await player.getByRole('button', { name: 'ゲームに参加・復帰' }).click();
    await player.getByRole('button', { name: '復帰する' }).click();
    await expect(player.getByRole('heading', { name: '週次プレイ' })).toBeVisible();
    await expect(player.getByText('RETAILER', { exact: true })).toBeVisible();
    await expect(player.getByText('WHOLESALER', { exact: true })).toHaveCount(0);
    await expect(player.getByRole('status')).toContainText('再接続中');
  } finally {
    await host.close();
    await Promise.all(participants.map((context) => context.close()));
  }
});
