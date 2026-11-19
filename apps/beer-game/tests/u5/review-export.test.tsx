// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObservationPage, ReviewPage, ExportPanel } from '../../src/ui/LearningPages.js';
import { App } from '../../src/ui/App.js';
import type { BrowserApi } from '../../src/ui/browser-api.js';

const api = (methods: Record<string, unknown>) => methods as unknown as BrowserApi;
const series = Array.from({ length: 50 }, (_, index) => ({
  week: index + 1,
  inventory: index + 2,
  backlog: index,
  orders: 4,
  demand: 5,
  shipments: 3,
  costMinor: 100 + index,
}));
afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('Given a protected observation', () => {
  it('shows a suppression reason without mounting an unsafe total', async () => {
    render(
      <ObservationPage
        api={api({
          observation: vi.fn().mockResolvedValue({
            currentWeek: 2,
            completionStatus: { RETAILER: true },
            suppressionReasons: ['INSUFFICIENT_CONTRIBUTORS'],
          }),
        })}
        gameId="g"
      />,
    );
    expect(await screen.findByText('情報保護のため非表示')).toBeTruthy();
    expect(document.body.textContent).not.toContain('999');
    expect(screen.getByText('RETAILER: 入力済み')).toBeTruthy();
  });

  it('shows disclosed team totals as text', async () => {
    render(
      <ObservationPage
        api={api({
          observation: vi.fn().mockResolvedValue({
            currentWeek: 2,
            completionStatus: {},
            suppressionReasons: [],
            safeTeamTotals: { inventory: 28, backlog: 3, orders: 12 },
          }),
        })}
        gameId="g"
      />,
    );
    expect(await screen.findByText('28')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
  });
});

describe('Given a finished review', () => {
  it('renders 50 weeks in a chart and equivalent data table', async () => {
    render(
      <ReviewPage
        api={api({
          review: vi.fn().mockResolvedValue({ sourceVersion: 52, weeklySeries: series }),
        })}
        gameId="g"
        facilitator={false}
      />,
    );
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(51);
    expect(screen.getByRole('img', { name: '週次推移グラフ' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '表へ移動' }).getAttribute('href')).toBe(
      '#review-table',
    );
    expect(screen.getAllByText('149').length).toBeGreaterThan(0);
  });

  it('distinguishes an empty review from a load failure', async () => {
    render(
      <ReviewPage
        api={api({ review: vi.fn().mockResolvedValue({ sourceVersion: 1, weeklySeries: [] }) })}
        gameId="g"
        facilitator={false}
      />,
    );
    expect(await screen.findByText('データなし')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a safe error when review cannot load', async () => {
    render(
      <ReviewPage
        api={api({ review: vi.fn().mockRejectedValue(new Error('private failure')) })}
        gameId="g"
        facilitator={false}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toContain('振り返りを読み込めません');
    expect(document.body.textContent).not.toContain('private failure');
  });
});

describe('Given facilitator export', () => {
  it('offers both complete downloads with schema version', async () => {
    const browser = api({
      createExport: vi
        .fn()
        .mockResolvedValue({ exportId: 'e', status: 'COMPLETE', schemaVersion: '1.0.0' }),
      exportUrl: vi.fn((_: string, __: string, format: string) => `/download?format=${format}`),
    });
    render(<ExportPanel api={browser} gameId="g" />);
    fireEvent.click(screen.getByRole('button', { name: '出力を作成' }));
    expect(await screen.findByText('schema 1.0.0')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'CSV をダウンロード' }).getAttribute('href')).toBe(
      '/download?format=csv',
    );
    expect(screen.getByRole('link', { name: 'JSON をダウンロード' }).getAttribute('href')).toBe(
      '/download?format=json',
    );
  });

  it('waits for a pending export and never offers a partial download', async () => {
    const status = vi
      .fn()
      .mockResolvedValue({ exportId: 'e', status: 'PENDING', schemaVersion: '1.0.0' });
    render(
      <ExportPanel
        api={api({
          createExport: vi
            .fn()
            .mockResolvedValue({ exportId: 'e', status: 'PENDING', schemaVersion: '1.0.0' }),
          exportStatus: status,
        })}
        gameId="g"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '出力を作成' }));
    expect(await screen.findByText('生成中')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'CSV をダウンロード' })).toBeNull();
    await waitFor(() => expect(status).toHaveBeenCalled(), { timeout: 2000 });
  });

  it('reports a failed export without a download link', async () => {
    render(
      <ExportPanel
        api={api({
          createExport: vi
            .fn()
            .mockResolvedValue({ exportId: 'e', status: 'FAILED', schemaVersion: '1.0.0' }),
        })}
        gameId="g"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '出力を作成' }));
    expect((await screen.findByRole('alert')).textContent).toContain('失敗');
    expect(screen.queryByRole('link', { name: 'CSV をダウンロード' })).toBeNull();
  });
});

describe('Given a game in the browser', () => {
  it('opens observation from the facilitator console', async () => {
    const browser = api({
      createGame: vi
        .fn()
        .mockResolvedValue({ gameId: 'g', sessionId: 's', joinCode: 'ABCD1234', version: 1 }),
      lobby: vi.fn().mockResolvedValue({
        gameId: 'g',
        sessionId: 's',
        week: 1,
        version: 1,
        status: 'LOBBY',
        participants: [
          { participantId: 'r', role: 'RETAILER', displayName: 'R' },
          { participantId: 'w', role: 'WHOLESALER', displayName: 'W' },
          { participantId: 'd', role: 'DISTRIBUTOR', displayName: 'D' },
          { participantId: 'f', role: 'FACTORY', displayName: 'F' },
        ],
        decisions: {},
      }),
      lifecycle: vi.fn().mockResolvedValue({ status: 'ACTIVE', version: 2 }),
      observation: vi.fn().mockResolvedValue({
        currentWeek: 1,
        completionStatus: {},
        suppressionReasons: ['INSUFFICIENT_CONTRIBUTORS'],
      }),
    });
    render(<App api={browser} />);
    fireEvent.click(screen.getByRole('button', { name: 'ゲームを作る' }));
    fireEvent.click(screen.getByRole('button', { name: 'ゲームを作成' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ロビーへ' }));
    fireEvent.click(await screen.findByRole('button', { name: '開始する' }));
    fireEvent.click(await screen.findByRole('button', { name: '観察を見る' }));
    expect(await screen.findByRole('heading', { name: '観察' })).toBeTruthy();
  });
});
