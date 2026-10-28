import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:3100' },
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:3100/api/v1/games/not-found/events',
    env: { PORT: '3100', ALLOWED_ORIGIN: 'http://127.0.0.1:3100' },
    reuseExistingServer: true,
  },
});
