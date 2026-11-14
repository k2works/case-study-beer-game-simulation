import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import {
  bootLobbyGame,
  bootRunningGame,
  endGame,
  pauseGame,
  playUntilEnded,
  submitWeek,
  type RunningGame,
} from './api.js';
import { signIn, type SignIn } from './session.js';

/**
 * 画面 × 状態の一覧（performance-design.md「画面 × 状態の検査の対象」）。axe-core、状態の表示、日本語表示の
 * 3 つの試験が同じ一覧を使う。状態は公開の API で作る（画面の操作で毎回作らない）。
 */

export type ScreenName =
  'ゲームの作成' | '参加' | 'ロビー' | 'プレイ' | '進行管理' | '結果' | '観察';

export interface Opened {
  page: Page;
  context: BrowserContext;
}

export interface Indicator {
  name: string;
  locator: Locator;
}

export interface StateCase {
  id: string;
  screen: ScreenName;
  state: string;
  open(browser: Browser, baseUrl: string): Promise<Opened>;
  /** 状態を示す要素（文字またはアクセシブルな名前が空でないことを確かめる。NFR8.4） */
  indicators(page: Page): Indicator[];
}

async function openPage(
  browser: Browser,
  baseUrl: string,
  signedIn?: SignIn,
  prepare?: (context: BrowserContext) => Promise<void>,
): Promise<Opened> {
  const context = await browser.newContext({ baseURL: baseUrl });
  if (signedIn) {
    await signIn(context, signedIn);
  }
  await prepare?.(context);
  const page = await context.newPage();
  await page.goto('/');
  return { page, context };
}

const asFacilitator = (game: RunningGame): SignIn => ({
  kind: 'facilitator',
  secret: game.facilitatorCode,
  gameId: game.gameId,
});

const asPlayer = (game: RunningGame): SignIn => ({
  kind: 'participant',
  secret: game.players.retailer.token,
  gameId: game.gameId,
});

async function runningWithInputs(baseUrl: string): Promise<RunningGame> {
  const game = await bootRunningGame(baseUrl, { weekCount: 3 });
  await submitWeek(baseUrl, game, 1);
  return game;
}

/** 接続の失敗の状態: 状態の取り直しを遮断する（取り直しは 1 秒おきに失敗し、帯が出る）。 */
async function blockStateRequests(context: BrowserContext): Promise<void> {
  await context.route('**/api/games/*/state', (route) => route.abort('connectionrefused'));
}

const alertOf = (page: Page): Indicator[] => [
  { name: 'エラーの通知', locator: page.getByRole('alert') },
];

export const STATE_CASES: StateCase[] = [
  {
    id: 'create-normal',
    screen: 'ゲームの作成',
    state: '通常',
    open: async (browser, baseUrl) => {
      const opened = await openPage(browser, baseUrl);
      await opened.page.getByTestId('go-create').click();
      await opened.page.getByRole('heading', { name: 'ゲームを作成する' }).waitFor();
      return opened;
    },
    indicators: (page) => [{ name: '作成ボタン', locator: page.getByTestId('create-submit') }],
  },
  {
    id: 'create-error',
    screen: 'ゲームの作成',
    state: '入力エラー',
    open: async (browser, baseUrl) => {
      const opened = await openPage(browser, baseUrl);
      await opened.page.getByTestId('go-create').click();
      await opened.page.getByTestId('create-submit').click();
      await opened.page.getByRole('alert').first().waitFor();
      return opened;
    },
    indicators: alertOf,
  },
  {
    id: 'join-normal',
    screen: '参加',
    state: '通常',
    open: async (browser, baseUrl) => {
      const opened = await openPage(browser, baseUrl);
      await opened.page.getByRole('heading', { name: 'ゲームに参加する' }).waitFor();
      return opened;
    },
    indicators: (page) => [{ name: '参加ボタン', locator: page.getByTestId('join-submit') }],
  },
  {
    id: 'join-invalid-code',
    screen: '参加',
    state: '無効な資格情報のエラー',
    open: async (browser, baseUrl) => {
      const opened = await openPage(browser, baseUrl);
      await opened.page.getByLabel('参加コード').fill('XXXXXXXXXX');
      await opened.page.getByLabel('表示名').fill('試験チーム 01 確認');
      await opened.page.getByTestId('join-submit').click();
      await opened.page.getByRole('alert').first().waitFor();
      return opened;
    },
    indicators: alertOf,
  },
  {
    id: 'lobby-unassigned',
    screen: 'ロビー',
    state: '役割の割当て中（未割当てあり）',
    open: async (browser, baseUrl) => {
      const game = await bootLobbyGame(baseUrl, { assigned: false });
      const opened = await openPage(browser, baseUrl, asFacilitator(game));
      await opened.page.getByRole('heading', { name: 'ロビー' }).waitFor();
      await opened.page.getByTestId('start-blocker').waitFor();
      return opened;
    },
    indicators: (page) => [
      { name: '開始できない理由', locator: page.getByTestId('start-blocker') },
      { name: '役割の選択', locator: page.getByRole('combobox') },
    ],
  },
  {
    id: 'lobby-participant',
    screen: 'ロビー',
    state: '開始の待ち（参加者）',
    open: async (browser, baseUrl) => {
      const game = await bootLobbyGame(baseUrl, { assigned: true });
      const opened = await openPage(browser, baseUrl, asPlayer(game));
      await opened.page.getByRole('heading', { name: 'ロビー' }).waitFor();
      return opened;
    },
    indicators: (page) => [{ name: '開始の待ち', locator: page.getByText('開始を待っています') }],
  },
  {
    id: 'play-empty',
    screen: 'プレイ',
    state: '通常（未入力）',
    open: async (browser, baseUrl) => {
      const game = await bootRunningGame(baseUrl);
      const opened = await openPage(browser, baseUrl, asPlayer(game));
      await opened.page.getByText('入力: 未入力').waitFor();
      return opened;
    },
    indicators: (page) => [{ name: '入力の状態', locator: page.getByText('入力: 未入力') }],
  },
  {
    id: 'play-entered',
    screen: 'プレイ',
    state: '通常（入力済み）',
    open: async (browser, baseUrl) => {
      const game = await runningWithInputs(baseUrl);
      const opened = await openPage(browser, baseUrl, asPlayer(game));
      await opened.page.getByText(/入力: 保存済み/).waitFor();
      return opened;
    },
    indicators: (page) => [{ name: '入力の状態', locator: page.getByText(/入力: 保存済み/) }],
  },
  {
    id: 'play-paused',
    screen: 'プレイ',
    state: '一時停止',
    open: async (browser, baseUrl) => {
      const game = await bootRunningGame(baseUrl);
      await pauseGame(baseUrl, game);
      const opened = await openPage(browser, baseUrl, asPlayer(game));
      await opened.page.getByTestId('paused-notice').waitFor();
      return opened;
    },
    indicators: (page) => [
      { name: '一時停止の通知', locator: page.getByTestId('paused-notice') },
      { name: '状態の表示', locator: page.getByText('状態: 一時停止中') },
    ],
  },
  {
    id: 'play-ended',
    screen: 'プレイ',
    state: '終了',
    open: async (browser, baseUrl) => {
      const game = await bootRunningGame(baseUrl, { weekCount: 2 });
      await playUntilEnded(baseUrl, game);
      const opened = await openPage(browser, baseUrl, asPlayer(game));
      await opened.page.getByText('ゲームは終了しました').first().waitFor();
      return opened;
    },
    indicators: (page) => [
      { name: '状態の表示', locator: page.getByText('状態: 終了') },
      {
        name: '終了の通知',
        locator: page.getByRole('status').filter({ hasText: 'ゲームは終了しました' }),
      },
    ],
  },
  {
    id: 'play-connection-lost',
    screen: 'プレイ',
    state: 'エラー（接続の失敗）',
    open: async (browser, baseUrl) => {
      const game = await bootRunningGame(baseUrl);
      const opened = await openPage(browser, baseUrl, asPlayer(game), blockStateRequests);
      await opened.page.getByTestId('connection-lost').waitFor();
      return opened;
    },
    indicators: (page) => [{ name: '接続の通知', locator: page.getByTestId('connection-lost') }],
  },
  {
    id: 'play-invalid-credential',
    screen: 'プレイ',
    state: 'エラー（無効な資格情報）',
    open: async (browser, baseUrl) => {
      const game = await bootRunningGame(baseUrl);
      const opened = await openPage(browser, baseUrl, {
        kind: 'participant',
        secret: `${game.players.retailer.token}-invalid`,
        gameId: game.gameId,
      });
      await opened.page.getByTestId('credential-notice').waitFor();
      return opened;
    },
    indicators: (page) => [
      { name: '資格情報の案内', locator: page.getByTestId('credential-notice') },
    ],
  },
  {
    id: 'facilitator-normal',
    screen: '進行管理',
    state: '通常',
    open: async (browser, baseUrl) => {
      const game = await runningWithInputs(baseUrl);
      const opened = await openPage(browser, baseUrl, asFacilitator(game));
      await opened.page.getByRole('heading', { name: '進行管理' }).waitFor();
      return opened;
    },
    indicators: (page) => [
      { name: 'ゲームの状態', locator: page.getByTestId('game-status') },
      { name: '入力の状況', locator: page.getByText(/役割が入力済み/) },
    ],
  },
  {
    id: 'facilitator-paused',
    screen: '進行管理',
    state: '一時停止',
    open: async (browser, baseUrl) => {
      const game = await bootRunningGame(baseUrl);
      await pauseGame(baseUrl, game);
      const opened = await openPage(browser, baseUrl, asFacilitator(game));
      await opened.page.getByTestId('paused-banner').waitFor();
      return opened;
    },
    indicators: (page) => [
      { name: 'ゲームの状態', locator: page.getByTestId('game-status') },
      { name: '一時停止の通知', locator: page.getByTestId('paused-banner') },
    ],
  },
  {
    id: 'facilitator-ended-export',
    screen: '進行管理',
    state: '終了（出力の注意書き）',
    open: async (browser, baseUrl) => {
      const game = await bootRunningGame(baseUrl, { weekCount: 2 });
      await playUntilEnded(baseUrl, game);
      const opened = await openPage(browser, baseUrl, asFacilitator(game));
      await opened.page.getByTestId('export-notice').waitFor();
      return opened;
    },
    indicators: (page) => [
      { name: 'ゲームの状態', locator: page.getByTestId('game-status') },
      { name: '出力の注意書き', locator: page.getByTestId('export-notice') },
    ],
  },
  {
    id: 'facilitator-connection-lost',
    screen: '進行管理',
    state: 'エラー（接続の失敗）',
    open: async (browser, baseUrl) => {
      const game = await bootRunningGame(baseUrl);
      const opened = await openPage(browser, baseUrl, asFacilitator(game), blockStateRequests);
      await opened.page.getByTestId('connection-lost').waitFor();
      return opened;
    },
    indicators: (page) => [{ name: '接続の通知', locator: page.getByTestId('connection-lost') }],
  },
  {
    id: 'results-shown',
    screen: '結果',
    state: '結果の表示（終了後）',
    open: async (browser, baseUrl) => {
      const game = await bootRunningGame(baseUrl, { weekCount: 2 });
      await playUntilEnded(baseUrl, game);
      const opened = await openPage(browser, baseUrl, asFacilitator(game));
      await opened.page.getByTestId('show-results').click();
      await opened.page.getByTestId('results-screen').waitFor();
      return opened;
    },
    indicators: (page) => [
      { name: '指標の選択', locator: page.getByRole('radio') },
      { name: '結果の要約', locator: page.getByTestId('results-summary') },
    ],
  },
  {
    id: 'results-metric-selected',
    screen: '結果',
    state: '指標を切り替えた状態',
    open: async (browser, baseUrl) => {
      const game = await bootRunningGame(baseUrl, { weekCount: 2 });
      await playUntilEnded(baseUrl, game);
      const opened = await openPage(browser, baseUrl, asPlayer(game));
      await opened.page.getByTestId('show-results').click();
      await opened.page.getByTestId('results-screen').waitFor();
      await opened.page.getByTestId('metric-inventory').check();
      return opened;
    },
    indicators: (page) => [{ name: '指標の選択', locator: page.getByRole('radio') }],
  },
  {
    id: 'results-empty',
    screen: '結果',
    state: '確定した週がない',
    open: async (browser, baseUrl) => {
      const game = await bootRunningGame(baseUrl, { weekCount: 2 });
      await endGame(baseUrl, game);
      const opened = await openPage(browser, baseUrl, asFacilitator(game));
      await opened.page.getByTestId('show-results').click();
      await opened.page.getByTestId('results-empty').waitFor();
      return opened;
    },
    indicators: (page) => [{ name: '空の通知', locator: page.getByTestId('results-empty') }],
  },
  {
    id: 'observer-normal',
    screen: '観察',
    state: '通常',
    open: async (browser, baseUrl) => {
      const game = await runningWithInputs(baseUrl);
      const opened = await openPage(browser, baseUrl, {
        kind: 'observer',
        secret: game.observerCode,
        gameId: game.gameId,
      });
      await opened.page.getByTestId('observer-view').waitFor();
      return opened;
    },
    indicators: (page) => [
      { name: '状態', locator: page.getByTestId('observer-status') },
      { name: '入力の状況', locator: page.getByTestId('observer-inputs') },
    ],
  },
];
