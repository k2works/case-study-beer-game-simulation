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
import { ApiError, type ApiClient } from '../../ui/src/api/types.js';

afterEach(cleanup);

const lobbyBase = {
  gameId: 'g1',
  status: 'PREPARING' as const,
  finalWeek: 10,
  participants: [{ id: 'p1', displayName: '花子' }],
  assignments: {},
  missingRoles: ['FACTORY', 'DISTRIBUTOR', 'WHOLESALER', 'RETAILER'],
  viewer: { kind: 'FACILITATOR' as const },
  joinCode: 'ABCD2345',
};

const roleView = (role: string, extra: object = {}) => ({
  role,
  commitMode: 'MANUAL' as const,
  status: 'ACTIVE' as const,
  week: 3,
  sessionVersion: 4,
  inventory: 12,
  backlog: 0,
  incomingGoods: [4, 4],
  decision: null,
  history: [
    {
      week: 1,
      order: 4,
      demand: 4,
      received: 4,
      shipped: 4,
      endingInventory: 12,
      endingBacklog: 0,
      weeklyCostMinor: 600,
      cumulativeCostMinor: 600,
    },
  ],
  ...extra,
});

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    createGame: vi
      .fn()
      .mockResolvedValue({ gameId: 'g1', joinCode: 'ABCD2345' }),
    join: vi.fn().mockResolvedValue({ gameId: 'g1', participantId: 'p1' }),
    lobby: vi.fn().mockResolvedValue(lobbyBase),
    assign: vi.fn().mockResolvedValue(undefined),
    unassign: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    me: vi.fn().mockResolvedValue(roleView('RETAILER', { customerDemand: 4 })),
    console: vi.fn().mockResolvedValue({
      status: 'ACTIVE',
      week: 3,
      sessionVersion: 7,
      submitted: {
        FACTORY: true,
        DISTRIBUTOR: true,
        WHOLESALER: false,
        RETAILER: true,
      },
    }),
    saveDecision: vi.fn().mockResolvedValue({ version: 1 }),
    commit: vi
      .fn()
      .mockResolvedValue({ committedWeek: 3, nextWeek: 4, status: 'ACTIVE' }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

const renderAt = (path: string, api: ApiClient) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App api={api} pollMs={0} />
    </MemoryRouter>,
  );

describe('ホームとルーティング', () => {
  it('[US1.1] ホームから、作成と参加へ進める。題名が設定される', () => {
    renderAt('/', fakeApi());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'ビールゲーム',
    );
    expect(screen.getByRole('link', { name: 'ゲームを作る' })).toHaveAttribute(
      'href',
      '/new',
    );
    expect(screen.getByRole('link', { name: '参加する' })).toHaveAttribute(
      'href',
      '/join',
    );
    expect(document.title).toContain('ビールゲーム');
  });

  it('[US1.1] 見出しにフォーカスが移る', () => {
    renderAt('/new', fakeApi());
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });
});

describe('ナビゲーションメニュー', () => {
  it('[US2.1] どの画面にもメニューがあり、ホーム・作成・参加へ移れる', () => {
    renderAt('/new', fakeApi());
    const nav = screen.getByRole('navigation', { name: 'メインメニュー' });
    expect(within(nav).getByRole('link', { name: 'ホーム' })).toHaveAttribute(
      'href',
      '/',
    );
    expect(
      within(nav).getByRole('link', { name: '新しいゲーム' }),
    ).toHaveAttribute('href', '/new');
    expect(
      within(nav).getByRole('link', { name: 'ゲームに参加' }),
    ).toHaveAttribute('href', '/join');
    expect(
      within(nav).queryByRole('link', { name: 'ロビー' }),
    ).not.toBeInTheDocument();
  });

  it('[US2.1] ゲーム中は、ロビー・自分の画面・進行役コンソールを行き来でき、現在の画面が分かる', async () => {
    renderAt('/games/g1/lobby', fakeApi());
    const nav = screen.getByRole('navigation', { name: 'メインメニュー' });
    expect(within(nav).getByRole('link', { name: 'ロビー' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      within(nav).getByRole('link', { name: '自分の画面' }),
    ).toHaveAttribute('href', '/games/g1/play');
    await userEvent.click(
      within(nav).getByRole('link', { name: '進行役コンソール' }),
    );
    expect(
      await screen.findByRole('heading', { name: '進行役コンソール' }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole('link', { name: '進行役コンソール' }),
    ).toHaveAttribute('aria-current', 'page');
    await userEvent.click(
      within(nav).getByRole('link', { name: '自分の画面' }),
    );
    expect(
      await screen.findByRole('heading', { name: /小売店/ }),
    ).toBeInTheDocument();
  });
});

describe('作成', () => {
  it('[US1.1/AC1.1.1] 週数を入れて作成すると、ロビーへ進み、参加コードが表示される', async () => {
    const api = fakeApi();
    renderAt('/new', api);
    const weeks = screen.getByLabelText('週数');
    await userEvent.clear(weeks);
    await userEvent.type(weeks, '10');
    await userEvent.click(screen.getByRole('button', { name: '作成する' }));
    expect(api.createGame).toHaveBeenCalledWith({
      weeks: 10,
      commitMode: 'AUTO',
    });
    expect(await screen.findByText('ABCD2345')).toBeInTheDocument();
  });

  it('[US1.1/AC1.1.2] 無効な場合は、対象週と修正内容を示し、入力を保持する', async () => {
    const api = fakeApi({
      createGame: vi
        .fn()
        .mockRejectedValue(
          new ApiError(422, '需要系列が無効です', [
            { week: 3, problem: '範囲外です', fix: '0〜1000 にしてください' },
          ]),
        ),
    });
    renderAt('/new', api);
    await userEvent.clear(screen.getByLabelText('週数'));
    await userEvent.type(screen.getByLabelText('週数'), '7');
    await userEvent.click(screen.getByRole('button', { name: '作成する' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('3 週目');
    expect(alert).toHaveTextContent('0〜1000 にしてください');
    expect(screen.getByLabelText('週数')).toHaveValue(7);
  });
});

describe('確定方式の選択', () => {
  it('[US2.4] 「全員が保存したら自動で次の週に進む」は既定でオン。外すと手動で作成する', async () => {
    const api = fakeApi();
    renderAt('/new', api);
    const box = screen.getByLabelText('全員が保存したら自動で次の週に進む');
    expect(box).toBeChecked();
    await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: '作成する' }));
    expect(api.createGame).toHaveBeenCalledWith({
      weeks: 20,
      commitMode: 'MANUAL',
    });
  });
});

describe('参加', () => {
  it('[US1.2/AC1.2.1] 参加コードと表示名で参加し、ロビーへ進む', async () => {
    const api = fakeApi({
      lobby: vi.fn().mockResolvedValue({
        ...lobbyBase,
        viewer: { kind: 'PARTICIPANT', participantId: 'p1' },
        joinCode: undefined,
      }),
    });
    renderAt('/join', api);
    await userEvent.type(screen.getByLabelText('参加コード'), 'ABCD2345');
    await userEvent.type(screen.getByLabelText('表示名'), '花子');
    await userEvent.click(screen.getByRole('button', { name: '参加する' }));
    expect(api.join).toHaveBeenCalledWith({
      joinCode: 'ABCD2345',
      displayName: '花子',
    });
    expect(await screen.findByText('開始を待っています')).toBeInTheDocument();
  });

  it('[US1.2/AC1.2.2] 受付終了などの理由を表示する', async () => {
    const api = fakeApi({
      join: vi
        .fn()
        .mockRejectedValue(
          new ApiError(422, 'このゲームは参加の受付を終了しています'),
        ),
    });
    renderAt('/join', api);
    await userEvent.type(screen.getByLabelText('参加コード'), 'X');
    await userEvent.type(screen.getByLabelText('表示名'), 'y');
    await userEvent.click(screen.getByRole('button', { name: '参加する' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('受付を終了');
  });
});

describe('ロビー', () => {
  it('[US1.2] 進行役は、参加者に役割を割り当て・解除でき、足りない役割が示される', async () => {
    const api = fakeApi();
    renderAt('/games/g1/lobby', api);
    expect(await screen.findByText('ABCD2345')).toBeInTheDocument();
    expect(screen.getByText(/足りない役割/)).toHaveTextContent('工場');
    await userEvent.selectOptions(
      screen.getByLabelText('花子 の役割'),
      'RETAILER',
    );
    expect(api.assign).toHaveBeenCalledWith('g1', 'p1', 'RETAILER');
    expect(screen.getByRole('button', { name: '開始する' })).toBeDisabled();
  });

  it('[US1.2] 役割を付け替えると、解除してから割り当てる。他の人の役割は選べない', async () => {
    const order: string[] = [];
    const api = fakeApi({
      lobby: vi.fn().mockResolvedValue({
        ...lobbyBase,
        participants: [
          { id: 'p1', displayName: '花子' },
          { id: 'p2', displayName: '太郎' },
        ],
        assignments: { RETAILER: 'p1', FACTORY: 'p2' },
        missingRoles: ['DISTRIBUTOR', 'WHOLESALER'],
      }),
      assign: vi.fn().mockImplementation(async () => void order.push('assign')),
      unassign: vi
        .fn()
        .mockImplementation(async () => void order.push('unassign')),
    });
    renderAt('/games/g1/lobby', api);
    const select = await screen.findByLabelText('花子 の役割');
    expect(
      within(select).getByRole('option', { name: /工場.*太郎/ }),
    ).toBeDisabled();
    await userEvent.selectOptions(select, 'WHOLESALER');
    expect(order).toEqual(['unassign', 'assign']);
    expect(api.assign).toHaveBeenCalledWith('g1', 'p1', 'WHOLESALER');
  });

  it('[US1.2/AC1.2.3] 4 役割がそろえば開始でき、コンソールへ進む', async () => {
    const api = fakeApi({
      lobby: vi.fn().mockResolvedValue({ ...lobbyBase, missingRoles: [] }),
    });
    renderAt('/games/g1/lobby', api);
    await userEvent.click(
      await screen.findByRole('button', { name: '開始する' }),
    );
    expect(api.start).toHaveBeenCalledWith('g1');
    expect(
      await screen.findByRole('heading', { name: /コンソール/ }),
    ).toBeInTheDocument();
  });

  it('[US1.2/AC1.2.3] 参加者は、開始されると自分の画面へ進む', async () => {
    const api = fakeApi({
      lobby: vi.fn().mockResolvedValue({
        ...lobbyBase,
        status: 'STARTED',
        viewer: { kind: 'PARTICIPANT', participantId: 'p1' },
        joinCode: undefined,
      }),
    });
    renderAt('/games/g1/lobby', api);
    expect(
      await screen.findByRole('heading', { name: /小売店/ }),
    ).toBeInTheDocument();
  });

  it('[US2.1] 資格が無ければ、参加へ誘導する', async () => {
    const api = fakeApi({
      lobby: vi
        .fn()
        .mockRejectedValue(new ApiError(401, '参加または復帰が必要です')),
    });
    renderAt('/games/g1/lobby', api);
    expect(
      await screen.findByRole('heading', { name: '参加する' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('参加または復帰');
  });
});

describe('プレイ', () => {
  it('[US2.1/AC2.1.1] 小売店は顧客需要と「発注数」を見る', async () => {
    renderAt('/games/g1/play', fakeApi());
    expect(
      await screen.findByRole('heading', { name: /小売店/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('今週の顧客需要')).toBeInTheDocument();
    expect(screen.getByLabelText('発注数')).toBeInTheDocument();
    expect(screen.getByText(/3 週目/)).toBeInTheDocument();
  });

  it('[US2.1/AC2.1.2] 工場は「生産要請数」で、顧客需要を見ない', async () => {
    const api = fakeApi({ me: vi.fn().mockResolvedValue(roleView('FACTORY')) });
    renderAt('/games/g1/play', api);
    expect(await screen.findByLabelText('生産要請数')).toBeInTheDocument();
    expect(screen.queryByText('今週の顧客需要')).not.toBeInTheDocument();
  });

  it('[US2.2/AC2.2.1] 数量を保存すると、版つきで API を呼ぶ', async () => {
    const api = fakeApi();
    renderAt('/games/g1/play', api);
    const input = await screen.findByLabelText('発注数');
    await userEvent.type(input, '6');
    await userEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect(api.saveDecision).toHaveBeenCalledWith('g1', 'RETAILER', 6, 0);
    expect(await screen.findByText('保存しました')).toBeInTheDocument();
  });

  it('[US2.3/AC2.3.1] 保存済みなら、次の週に進む条件（ほかの役割と進行役の確定）を示す', async () => {
    const api = fakeApi({
      me: vi
        .fn()
        .mockResolvedValue(
          roleView('RETAILER', { decision: { quantity: 6, version: 1 } }),
        ),
    });
    renderAt('/games/g1/play', api);
    const note = await screen.findByTestId('waiting');
    expect(note).toHaveTextContent('6');
    expect(note).toHaveTextContent('進行役が週を確定');
    expect(
      within(note).getByRole('link', { name: '進行役コンソール' }),
    ).toHaveAttribute('href', '/games/g1/console');
  });

  it('[US2.4] 自動確定のゲームでは、保存後に「そろうと自動で進む」と案内する', async () => {
    const api = fakeApi({
      me: vi.fn().mockResolvedValue(
        roleView('RETAILER', {
          commitMode: 'AUTO',
          decision: { quantity: 6, version: 1 },
        }),
      ),
    });
    renderAt('/games/g1/play', api);
    const note = await screen.findByTestId('waiting');
    expect(note).toHaveTextContent('自動で次の週に進みます');
    expect(note).not.toHaveTextContent('進行役が週を確定');
  });

  it('[US2.3/AC2.3.1] 週が進むと、「保存しました」は消え、新しい週の入力を促す', async () => {
    let week = 3;
    const api = fakeApi({
      me: vi.fn().mockImplementation(async () =>
        roleView('RETAILER', {
          week,
          decision: week === 3 ? null : null,
        }),
      ),
    });
    let notify: () => void = () => {};
    api.subscribe = vi.fn().mockImplementation((_id, cb) => {
      notify = cb;
      return () => {};
    });
    renderAt('/games/g1/play', api);
    await userEvent.type(await screen.findByLabelText('発注数'), '6');
    await userEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect(await screen.findByText('保存しました')).toBeInTheDocument();
    week = 4;
    notify();
    expect(await screen.findByText(/4 週目/)).toBeInTheDocument();
    expect(screen.queryByText('保存しました')).not.toBeInTheDocument();
  });

  it('[US2.4/AC2.4.1] 保存で自動確定されたら、次の週に進んだことを知らせる', async () => {
    const api = fakeApi({
      saveDecision: vi.fn().mockResolvedValue({
        version: 1,
        committed: { committedWeek: 3, nextWeek: 4, status: 'ACTIVE' },
      }),
    });
    renderAt('/games/g1/play', api);
    await userEvent.type(await screen.findByLabelText('発注数'), '6');
    await userEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect(
      await screen.findByText(/全員の発注がそろい、4 週目に進みました/),
    ).toBeInTheDocument();
  });

  it('[US2.2/AC2.2.2] 空欄は保存せず、修正方法を示し、入力を保持する', async () => {
    const api = fakeApi();
    renderAt('/games/g1/play', api);
    await screen.findByLabelText('発注数');
    await userEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect(api.saveDecision).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      '0 以上の整数を入力してください',
    );
  });

  it('[US2.2/AC2.2.2] 保存の失敗（範囲外・小数など）を、入力を保持して表示する', async () => {
    const api = fakeApi({
      saveDecision: vi
        .fn()
        .mockRejectedValue(new ApiError(422, '数量は 0〜1000 の整数です')),
    });
    renderAt('/games/g1/play', api);
    await userEvent.type(await screen.findByLabelText('発注数'), '5000');
    await userEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('0〜1000');
  });

  it('[US2.3/AC2.3.5] 自分の役割の履歴を表で見られる', async () => {
    renderAt('/games/g1/play', fakeApi());
    const table = await screen.findByRole('table', { name: '週ごとの結果' });
    expect(within(table).getAllByText('$6.00').length).toBeGreaterThan(0);
  });

  it('[US2.1] 変化の通知を購読し、通知されたら再取得する', async () => {
    let notify: () => void = () => {};
    const api = fakeApi({
      subscribe: vi.fn().mockImplementation((_id, cb) => {
        notify = cb;
        return () => {};
      }),
    });
    renderAt('/games/g1/play', api);
    await screen.findByLabelText('発注数');
    const calls = vi.mocked(api.me).mock.calls.length;
    notify();
    await waitFor(() =>
      expect(vi.mocked(api.me).mock.calls.length).toBeGreaterThan(calls),
    );
  });
});

describe('コンソール', () => {
  it('[US2.1/AC2.1.3] 入力の有無だけが見え、そろうまで確定できない', async () => {
    renderAt('/games/g1/console', fakeApi());
    expect(
      await screen.findByRole('heading', { name: /コンソール/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('二次卸')).toBeInTheDocument();
    expect(screen.getAllByText('入力済み')).toHaveLength(3);
    expect(screen.getAllByText('未入力')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '週を確定する' })).toBeDisabled();
  });

  it('[US1.2] 進行役が参加者を兼ねているときの、自分の画面への入口がある', async () => {
    renderAt('/games/g1/console', fakeApi());
    const link = await screen.findByRole('link', { name: '参加者として遊ぶ' });
    expect(link).toHaveAttribute('href', '/games/g1/play');
  });

  it('[US2.3/AC2.3.1] そろえば、確認ダイアログを経て、版と冪等キーつきで確定する', async () => {
    const api = fakeApi({
      console: vi.fn().mockResolvedValue({
        status: 'ACTIVE',
        week: 3,
        sessionVersion: 7,
        submitted: {
          FACTORY: true,
          DISTRIBUTOR: true,
          WHOLESALER: true,
          RETAILER: true,
        },
      }),
    });
    renderAt('/games/g1/console', api);
    await userEvent.click(
      await screen.findByRole('button', { name: '週を確定する' }),
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('3 週目');
    await userEvent.click(
      within(dialog).getByRole('button', { name: '確定する' }),
    );
    expect(api.commit).toHaveBeenCalledWith(
      'g1',
      3,
      7,
      expect.stringMatching(/.+/),
    );
  });
});
