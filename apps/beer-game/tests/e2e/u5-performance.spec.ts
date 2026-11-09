import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const origin = 'http://127.0.0.1:3100';
const roles = ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'] as const;

function p95(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

async function recoverIntoPlay(context: BrowserContext, blockSse = false) {
  const page = await context.newPage();
  if (blockSse) await page.route('**/api/v1/games/*/events', (route) => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'ゲームに参加・復帰' }).click();
  await page.getByRole('button', { name: '復帰する' }).click();
  await expect(page.getByRole('heading', { name: '週次プレイ' })).toBeVisible();
  await expect(page.getByText('第 1 週')).toBeVisible();
  return page;
}

async function commitFromBrowser(page: Page, week: number) {
  await expect(page.getByRole('button', { name: '週を確定' })).toBeEnabled();
  await page.getByRole('button', { name: '週を確定' }).click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: '確定する' });
  await page.evaluate(() => {
    const button = document.querySelector('[role="dialog"] button:last-child');
    button?.addEventListener(
      'click',
      () => {
        (window as Window & { __commitAt?: number }).__commitAt = performance.now();
      },
      { once: true, capture: true },
    );
  });
  await confirm.click();
  await expect(page.getByText(`第 ${week + 1} 週、状態: ACTIVE`)).toBeVisible();
  return page.evaluate(() => {
    const started = (window as Window & { __commitAt?: number }).__commitAt;
    if (started === undefined) throw new Error('Commit click was not observed');
    return performance.now() - started;
  });
}

async function submitFromBrowser(page: Page) {
  await page.getByRole('textbox', { name: '発注量' }).fill('4');
  await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (item) => item.textContent === '発注を保存',
    );
    button?.addEventListener(
      'click',
      () => {
        (window as Window & { __inputAt?: number }).__inputAt = performance.now();
      },
      { once: true, capture: true },
    );
  });
  const response = page.waitForResponse(
    (item) => item.url().includes('/decisions') && item.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: '発注を保存' }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole('status')).toContainText('発注を保存しました。');
  return page.evaluate(() => {
    const started = (window as Window & { __inputAt?: number }).__inputAt;
    if (started === undefined) throw new Error('Decision click was not observed');
    return performance.now() - started;
  });
}

test('Given 75-connection transport separately verified When weeks commit Then browser updates and 50-week review render stay in budget', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const facilitator = await browser.newContext();
  const participants = await Promise.all(roles.map(() => browser.newContext()));
  try {
    const host = await facilitator.newPage();
    await host.goto('/');
    await host.getByRole('button', { name: 'ゲームを作る' }).click();
    const createdResponse = host.waitForResponse((response) =>
      response.url().endsWith('/api/v1/games'),
    );
    await host.getByRole('button', { name: 'ゲームを作成' }).click();
    const created = await createdResponse;
    expect(created.status()).toBe(201);
    const game = (await created.json()) as { gameId: string; sessionId: string };
    await host.getByRole('button', { name: 'ロビーへ' }).click();
    for (const [index, role] of roles.entries()) {
      const joined = await participants[index].request.post(
        `${origin}/api/v1/games/${game.gameId}/participants`,
        {
          headers: { Origin: origin, 'Idempotency-Key': `perf-join-${game.gameId}-${index}` },
          data: { displayName: `P${index}` },
        },
      );
      expect(joined.status()).toBe(201);
      const { participantId } = (await joined.json()) as { participantId: string };
      const assigned = await facilitator.request.put(
        `${origin}/api/v1/games/${game.gameId}/participants/${participantId}/role`,
        {
          headers: {
            Origin: origin,
            'Idempotency-Key': `perf-role-${game.gameId}-${index}`,
            'If-Match': '1',
          },
          data: { role },
        },
      );
      expect(assigned.status()).toBe(200);
    }
    await expect(host.getByRole('button', { name: '開始する' })).toBeEnabled();
    await host.getByRole('button', { name: '開始する' }).click();
    await expect(host.getByRole('heading', { name: '進行役' })).toBeVisible();

    const live = await recoverIntoPlay(participants[0]);
    const fallback = await recoverIntoPlay(participants[1], true);
    await expect(fallback.getByRole('status')).toContainText('再接続中');
    const commitLatency: number[] = [];
    const inputLatency: number[] = [];
    const sseRenderLatency: number[] = [];
    const fallbackRenderLatency: number[] = [];
    for (let week = 1; week <= 5; week += 1) {
      inputLatency.push(await submitFromBrowser(live));
      for (const [index, context] of participants.entries()) {
        if (index === 0) continue;
        const decision = await context.request.put(
          `${origin}/api/v1/sessions/${game.sessionId}/decisions`,
          {
            headers: {
              Origin: origin,
              'Idempotency-Key': `perf-decision-${game.gameId}-${week}-${index}`,
              'If-Match': '0',
            },
            data: { quantity: 4 },
          },
        );
        expect(decision.status(), `week=${week} index=${index} ${await decision.text()}`).toBe(200);
      }
      await host.getByRole('button', { name: '手動更新' }).click();
      const liveStart = await live.evaluate(() => performance.now());
      const fallbackStart = await fallback.evaluate(() => performance.now());
      commitLatency.push(await commitFromBrowser(host, week));
      await expect(live.getByText(`第 ${week + 1} 週`)).toBeVisible();
      sseRenderLatency.push(await live.evaluate((start) => performance.now() - start, liveStart));
      await expect(fallback.getByText(`第 ${week + 1} 週`)).toBeVisible();
      fallbackRenderLatency.push(
        await fallback.evaluate((start) => performance.now() - start, fallbackStart),
      );
    }
    expect(p95(inputLatency)).toBeLessThanOrEqual(1_000);
    expect(p95(commitLatency)).toBeLessThanOrEqual(1_000);
    expect(p95(sseRenderLatency)).toBeLessThanOrEqual(2_000);
    expect(p95(fallbackRenderLatency)).toBeLessThanOrEqual(4_000);

    const rows = Array.from({ length: 50 }, (_, index) => ({
      week: index + 1,
      inventory: index + 3,
      backlog: index % 4,
      orders: 4,
      demand: 4,
      shipments: 4,
      costMinor: (index + 1) * 50,
    }));
    await host.route('**/api/v1/games/*/review', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'READY', sourceVersion: 50, weeklySeries: rows }),
      }),
    );
    await host.evaluate(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (String(args[0]).includes('/review')) {
          (
            window as Window & { __reviewResponseAt?: number; __reviewRenderedAt?: number }
          ).__reviewResponseAt = performance.now();
          const observer = new MutationObserver(() => {
            if (document.querySelectorAll('#review-table tbody tr').length === 50) {
              (window as Window & { __reviewRenderedAt?: number }).__reviewRenderedAt =
                performance.now();
              observer.disconnect();
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
        }
        return response;
      };
    });
    await host.getByRole('button', { name: '終了する' }).click();
    await host.getByRole('dialog').getByRole('button', { name: '確定する' }).click();
    await expect(host.locator('#review-table tbody tr')).toHaveCount(50);
    await expect(host.getByRole('img', { name: '週次推移グラフ' })).toBeVisible();
    expect(await host.locator('svg polyline').count()).toBe(6);
    for (const polyline of await host.locator('svg polyline').all())
      expect((await polyline.getAttribute('points'))?.trim().split(' ')).toHaveLength(50);
    const renderMs = await host.evaluate(() => {
      const measured = window as Window & {
        __reviewResponseAt?: number;
        __reviewRenderedAt?: number;
      };
      if (measured.__reviewResponseAt === undefined || measured.__reviewRenderedAt === undefined)
        throw new Error('Review render was not observed');
      return measured.__reviewRenderedAt - measured.__reviewResponseAt;
    });
    expect(renderMs).toBeLessThanOrEqual(100);
    process.stdout.write(
      JSON.stringify({
        inputP95Ms: p95(inputLatency),
        commitP95Ms: p95(commitLatency),
        sseRenderP95Ms: p95(sseRenderLatency),
        fallbackRenderP95Ms: p95(fallbackRenderLatency),
        reviewRows: 50,
        chartSeries: 6,
        reviewRenderMs: renderMs,
        note: 'Local Chromium, one browser clock per observed page. Five weekly commits; 50-week review response is synthetic. 75 SSE connections are measured separately by load:u5:db.',
      }) + '\n',
    );
  } finally {
    await facilitator.close();
    await Promise.all(participants.map((context) => context.close()));
  }
});
