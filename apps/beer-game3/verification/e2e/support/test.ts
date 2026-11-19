import { expect, test as base } from '@playwright/test';

/**
 * 画面の試験の test。接続先は、globalSetup が起動した使い捨てのアプリケーション（E2E_BASE_URL）。
 * 試験ごとに独立したゲームを作る（試験の間で状態を共有しない）。
 */
export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    await use(process.env.E2E_BASE_URL);
  },
});

export { expect };
