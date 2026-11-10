// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../ui/src/App.js';
import {
  ApiError,
  type ApiClient,
  type ReviewView,
} from '../../ui/src/api/types.js';

afterEach(cleanup);

const series = (f: (i: number) => number) => [1, 2, 3].map((_, i) => f(i));
const review: ReviewView = {
  weeks: [1, 2, 3],
  demand: [4, 8, 8],
  series: {
    order: {
      FACTORY: series((i) => 40 + i),
      DISTRIBUTOR: series((i) => 30 + i),
      WHOLESALER: series((i) => 20 + i),
      RETAILER: series((i) => 10 + i),
    },
    inventory: {
      FACTORY: series((i) => 1 + i),
      DISTRIBUTOR: series((i) => 2 + i),
      WHOLESALER: series((i) => 3 + i),
      RETAILER: series((i) => 4 + i),
    },
    backlog: {
      FACTORY: [0, 0, 0],
      DISTRIBUTOR: [0, 0, 0],
      WHOLESALER: [0, 0, 0],
      RETAILER: [0, 0, 0],
    },
    shipped: {
      FACTORY: [4, 4, 4],
      DISTRIBUTOR: [4, 4, 4],
      WHOLESALER: [4, 4, 4],
      RETAILER: [4, 8, 8],
    },
    cost: {
      FACTORY: [600, 600, 600],
      DISTRIBUTOR: [600, 600, 600],
      WHOLESALER: [600, 600, 600],
      RETAILER: [600, 400, 200],
    },
  },
};

function api(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    createGame: vi.fn(),
    join: vi.fn(),
    lobby: vi.fn(),
    assign: vi.fn(),
    unassign: vi.fn(),
    start: vi.fn(),
    me: vi.fn(),
    console: vi.fn(),
    saveDecision: vi.fn(),
    commit: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    review: vi.fn().mockResolvedValue(review),
    ...overrides,
  } as ApiClient;
}

const open = (a: ApiClient) =>
  render(
    <MemoryRouter initialEntries={['/games/g1/review']}>
      <App api={a} pollMs={0} />
    </MemoryRouter>,
  );

const tableColumns = (table: HTMLElement) => {
  const headers = within(table)
    .getAllByRole('columnheader')
    .map((h) => h.textContent ?? '');
  // 週は行見出し（th scope="row"）、値はセル。行の子要素を順に読む
  const rows = within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => [...r.children].map((c) => c.textContent ?? ''));
  return { headers, rows };
};

describe('振り返りの画面', () => {
  it('[US4.2/AC4.2.1] 既定は注文の推移。需要と 4 役割を同じ週の軸で並べる', async () => {
    open(api());
    const table = await screen.findByRole('table', {
      name: /注文.*グラフと同じ値/,
    });
    const { headers, rows } = tableColumns(table);
    expect(headers).toEqual([
      '週',
      '小売店',
      '二次卸',
      '一次卸',
      '工場',
      '需要',
    ]);
    expect(rows).toEqual([
      ['1', '10', '20', '30', '40', '4'],
      ['2', '11', '21', '31', '41', '8'],
      ['3', '12', '22', '32', '42', '8'],
    ]);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      '振り返り',
    );
    expect(document.title).toContain('振り返り');
  });

  it('[US4.2/AC4.2.4] 指標を切り替えると、グラフと表が同じ値で追従する', async () => {
    open(api());
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('radio', { name: '在庫' }));
    const table = screen.getByRole('table', { name: /在庫.*グラフと同じ値/ });
    expect(tableColumns(table).rows[0]).toEqual(['1', '4', '3', '2', '1']);
    expect(screen.getByRole('img')).toHaveAccessibleName(/在庫/);
  });

  it('[US4.2/AC4.2.4] 費用は金額で表示する（最小単位から変換）', async () => {
    open(api());
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('radio', { name: '費用' }));
    const table = screen.getByRole('table', { name: /費用/ });
    expect(tableColumns(table).rows[1]).toEqual([
      '2',
      '$4.00',
      '$6.00',
      '$6.00',
      '$6.00',
    ]);
  });

  it('[US4.2/AC4.2.4] 役割を切り替えると、グラフの系列と表の列が同時に増減する', async () => {
    open(api());
    await screen.findByRole('table');
    const chart = screen.getByRole('img');
    expect(chart.querySelectorAll('polyline')).toHaveLength(5);
    await userEvent.click(screen.getByRole('checkbox', { name: '工場' }));
    expect(chart.querySelectorAll('polyline')).toHaveLength(4);
    expect(tableColumns(screen.getByRole('table')).headers).toEqual([
      '週',
      '小売店',
      '二次卸',
      '一次卸',
      '需要',
    ]);
  });

  it('[US4.2/AC4.2.4] グラフの各系列の値は、表の同じ列の値と常に一致する', async () => {
    open(api());
    const table = await screen.findByRole('table');
    const chart = screen.getByRole('img');
    const { headers, rows } = tableColumns(table);
    for (const line of chart.querySelectorAll('polyline')) {
      const label = line.getAttribute('data-label')!;
      const column = headers.indexOf(label);
      expect(column).toBeGreaterThan(0);
      expect(line.getAttribute('data-values')).toBe(
        rows.map((r) => r[column]).join(','),
      );
    }
  });

  it('[US4.2/AC4.2.4] 需要は、注文と出荷でだけ選べる（在庫・費用には意味がない）', async () => {
    open(api());
    await screen.findByRole('table');
    expect(screen.getByRole('checkbox', { name: '需要' })).toBeEnabled();
    await userEvent.click(screen.getByRole('radio', { name: '在庫' }));
    expect(
      screen.queryByRole('checkbox', { name: '需要' }),
    ).not.toBeInTheDocument();
  });

  it('[US4.2/AC4.2.3] 0 件なら「データなし」を示す（エラーではない）', async () => {
    const empty: ReviewView = {
      weeks: [],
      demand: [],
      series: Object.fromEntries(
        Object.keys(review.series).map((m) => [
          m,
          { FACTORY: [], DISTRIBUTOR: [], WHOLESALER: [], RETAILER: [] },
        ]),
      ) as unknown as ReviewView['series'],
    };
    open(api({ review: vi.fn().mockResolvedValue(empty) }));
    expect(await screen.findByText('データなし')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('[US4.2/AC4.2.3] 取得に失敗したら、データなしとは別の文言で、再読み込みできる', async () => {
    const failing = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(500, '予期しないエラーが発生しました'),
      )
      .mockResolvedValue(review);
    open(api({ review: failing }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('読み込めませんでした');
    expect(screen.queryByText('データなし')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '再読み込み' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('[US4.2/AC4.2.2] 資格が無ければ（401）、参加の画面へ誘導する', async () => {
    open(
      api({
        review: vi
          .fn()
          .mockRejectedValue(new ApiError(401, '参加または復帰が必要です')),
      }),
    );
    expect(
      await screen.findByRole('heading', { name: '参加する' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('参加または復帰');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('[US4.2/AC4.2.2] 終了前（403）は、見られない理由を示し、グラフも表も出さない', async () => {
    open(
      api({
        review: vi
          .fn()
          .mockRejectedValue(
            new ApiError(403, '振り返りは、ゲームが終了してから見られます'),
          ),
      }),
    );
    expect(await screen.findByText(/ゲームが終了してから/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('データなし')).not.toBeInTheDocument(),
    );
  });

  it('[US4.2/AC4.2.1] グラフには要約の名前があり、線は線の種類で区別される', async () => {
    open(api());
    await screen.findByRole('table');
    const chart = screen.getByRole('img');
    expect(chart).toHaveAccessibleName(/注文.*週次/);
    const dashes = [...chart.querySelectorAll('polyline')].map(
      (l) => l.getAttribute('stroke-dasharray') ?? 'solid',
    );
    expect(new Set(dashes).size).toBe(5); // 色に頼らず、5 本とも線の種類が違う
  });
});

describe('振り返りへの導線', () => {
  it('[US4.2] メニューに「振り返り」がある', async () => {
    open(api());
    const nav = screen.getByRole('navigation', { name: 'メインメニュー' });
    expect(within(nav).getByRole('link', { name: '振り返り' })).toHaveAttribute(
      'href',
      '/games/g1/review',
    );
  });
});
