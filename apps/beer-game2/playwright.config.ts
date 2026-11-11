import { defineConfig } from '@playwright/test';
import {
  E2E_API_PORT as API_PORT,
  E2E_UI_PORT as UI_PORT,
} from './tests/e2e/ports.js';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${UI_PORT}`, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'npm run start',
      url: `http://localhost:${API_PORT}/ready`,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: String(API_PORT),
        ALLOWED_ORIGIN: `http://localhost:${UI_PORT}`,
        LOG_LEVEL: 'warn',
        // E2E はすべて同じ送信元から参加するため、参加・復帰の上限を緩める
        AUTH_RATE_LIMIT_PER_MINUTE: '10000',
      },
    },
    {
      command: 'npx vite',
      url: `http://localhost:${UI_PORT}`,
      reuseExistingServer: !process.env.CI,
      env: { UI_PORT: String(UI_PORT), API_PORT: String(API_PORT) },
    },
  ],
});
