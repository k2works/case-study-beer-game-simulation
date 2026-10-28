import { expect, test } from '@playwright/test';

test.describe('U1 walking skeleton boundary', () => {
  test('facilitator can create one game and receives secure session material', async ({
    request,
  }) => {
    const response = await request.post('/api/v1/games', {
      headers: { 'idempotency-key': 'e2e-create' },
      data: { finalWeek: 1, demand: [4] },
    });
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ version: 1 });
    expect(body.joinCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(response.headers()['set-cookie']).toContain('HttpOnly');
  });

  test('cross-origin mutation is rejected without leaking internals', async ({ request }) => {
    const response = await request.post('/api/v1/games', {
      headers: { origin: 'https://attacker.invalid', 'idempotency-key': 'e2e-origin' },
      data: { finalWeek: 1, demand: [4] },
    });
    expect(response.status()).toBe(403);
    const problem = await response.json();
    expect(problem).toMatchObject({ status: 403, title: 'ORIGIN_REJECTED' });
    expect(problem.correlationId).toBeTruthy();
  });
});
