import { defineConfig } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localChromeRoot = fileURLToPath(new URL('./.browser-binaries/chrome/', import.meta.url));
const chromeBinarySuffixes = [
  [
    'chrome-mac-x64',
    'Google Chrome for Testing.app',
    'Contents',
    'MacOS',
    'Google Chrome for Testing',
  ],
  [
    'chrome-mac-arm64',
    'Google Chrome for Testing.app',
    'Contents',
    'MacOS',
    'Google Chrome for Testing',
  ],
  ['chrome-linux64', 'chrome'],
  ['chrome-win64', 'chrome.exe'],
];
const localChrome = existsSync(localChromeRoot)
  ? readdirSync(localChromeRoot)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .flatMap((build) =>
        chromeBinarySuffixes.map((suffix) => join(localChromeRoot, build, ...suffix)),
      )
      .find(existsSync)
  : undefined;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  projects:
    process.env.U5_BROWSER_MATRIX === '1'
      ? [
          { name: 'chromium', use: { browserName: 'chromium' } },
          { name: 'firefox', use: { browserName: 'firefox' } },
          { name: 'webkit', use: { browserName: 'webkit' } },
          {
            name: 'chrome',
            use: localChrome
              ? { browserName: 'chromium', launchOptions: { executablePath: localChrome } }
              : { browserName: 'chromium', channel: 'chrome' },
          },
          { name: 'edge', use: { browserName: 'chromium', channel: 'msedge' } },
        ]
      : [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: { baseURL: 'http://127.0.0.1:3100' },
  webServer: {
    command: 'npm run build:ui && npm start',
    url: 'http://127.0.0.1:3100/api/v1/games/not-found/events',
    env: {
      PORT: '3100',
      ALLOWED_ORIGIN: 'http://127.0.0.1:3100',
      API_RATE_LIMIT_PER_MINUTE: '10000',
    },
    reuseExistingServer: true,
  },
});
