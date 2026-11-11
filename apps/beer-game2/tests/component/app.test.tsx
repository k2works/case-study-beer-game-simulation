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
  coHolders: ['花子'],
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
    createGame: vi.fn().mockResolvedValue({
      gameId: 'g1',
      joinCode: 'ABCD2345',
      recoveryCode: 'RECOVER-FAC',
    }),
    join: vi.fn().mockResolvedValue({
      gameId: 'g1',
      participantId: 'p1',
      recoveryCode: 'RECOVER-P1',
    }),
    recover: vi.fn().mockResolvedValue({
      gameId: 'g1',
      kind: 'PARTICIPANT',
      participantId: 'p1',
      gameStatus: 'STARTED',
    }),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    proxyDecision: vi.fn().mockResolvedValue({ version: 1 }),
    reissue: vi.fn().mockResolvedValue({ recoveryCode: 'NEW-CODE' }),
    lobby: vi.fn().mockResolvedValue(lobbyBase),
    assign: vi.fn().mockResolvedValue(undefined),
    unassign: vi.fn().mockResolvedValue(undefined),
    review: vi.fn(),
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
      versions: { FACTORY: 1, DISTRIBUTOR: 1, WHOLESALER: 0, RETAILER: 2 },
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

  it('[US1.2/AC1.2.4] 役割を付け替えると、解除してから割り当てる。他の人の役割にも、共同担当として加えられる', async () => {
    const order: string[] = [];
    const api = fakeApi({
      lobby: vi.fn().mockResolvedValue({
        ...lobbyBase,
        participants: [
          { id: 'p1', displayName: '花子' },
          { id: 'p2', displayName: '太郎' },
        ],
        assignments: { RETAILER: ['p1'], FACTORY: ['p2'] },
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
      within(select).getByRole('option', { name: /工場.*共同担当.*太郎/ }),
    ).toBeEnabled();
    await userEvent.selectOptions(select, 'WHOLESALER');
    expect(order).toEqual(['unassign', 'assign']);
    expect(api.assign).toHaveBeenCalledWith('g1', 'p1', 'WHOLESALER');
    await userEvent.selectOptions(select, 'FACTORY');
    expect(api.assign).toHaveBeenLastCalledWith('g1', 'p1', 'FACTORY');
  });

  it('[US1.2/AC1.2.4] 参加者のロビーは、役割ごとの担当（共同担当を含む）を示す', async () => {
    const api = fakeApi({
      lobby: vi.fn().mockResolvedValue({
        ...lobbyBase,
        viewer: { kind: 'PARTICIPANT', participantId: 'p1' },
        joinCode: undefined,
        participants: [
          { id: 'p1', displayName: '花子' },
          { id: 'p2', displayName: '太郎' },
        ],
        assignments: { RETAILER: ['p1', 'p2'] },
      }),
    });
    renderAt('/games/g1/lobby', api);
    expect(await screen.findByText(/花子（小売店）/)).toBeInTheDocument();
    expect(screen.getByText(/太郎（小売店）/)).toBeInTheDocument();
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
      me: vi.fn().mockResolvedValue(
        roleView('RETAILER', {
          decision: { quantity: 6, version: 1, savedBy: '花子' },
        }),
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
          decision: { quantity: 6, version: 1, savedBy: '花子' },
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

describe('終了後の導線', () => {
  it('[US4.2] 終了後の自分の画面と進行役コンソールに「振り返りを見る」がある', async () => {
    const api = fakeApi({
      me: vi.fn().mockResolvedValue(roleView('RETAILER', { status: 'ENDED' })),
      console: vi.fn().mockResolvedValue({
        status: 'ENDED',
        week: 3,
        sessionVersion: 9,
        submitted: {
          FACTORY: false,
          DISTRIBUTOR: false,
          WHOLESALER: false,
          RETAILER: false,
        },
      }),
    });
    const play = renderAt('/games/g1/play', api);
    expect(
      await screen.findByRole('link', { name: '振り返りを見る' }),
    ).toHaveAttribute('href', '/games/g1/review');
    play.unmount();
    renderAt('/games/g1/console', api);
    expect(
      await screen.findByRole('link', { name: '振り返りを見る' }),
    ).toHaveAttribute('href', '/games/g1/review');
  });

  it('[US4.2] 進行中は「振り返りを見る」を出さない', async () => {
    renderAt('/games/g1/play', fakeApi());
    await screen.findByLabelText('発注数');
    expect(
      screen.queryByRole('link', { name: '振り返りを見る' }),
    ).not.toBeInTheDocument();
  });
});

describe('コンソール', () => {
  it('[US2.1/AC2.1.3] 入力の有無だけが見え、そろうまで確定できない', async () => {
    renderAt('/games/g1/console', fakeApi());
    expect(
      await screen.findByRole('heading', { name: /コンソール/ }),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: '入力状況' });
    expect(within(table).getByText('二次卸')).toBeInTheDocument();
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
        versions: { FACTORY: 1, DISTRIBUTOR: 1, WHOLESALER: 1, RETAILER: 1 },
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

const consoleView = (extra: object = {}) => ({
  status: 'ACTIVE' as const,
  week: 3,
  sessionVersion: 7,
  submitted: {
    FACTORY: true,
    DISTRIBUTOR: true,
    WHOLESALER: false,
    RETAILER: true,
  },
  versions: { FACTORY: 1, DISTRIBUTOR: 1, WHOLESALER: 0, RETAILER: 2 },
  ...extra,
});

describe('復帰コード', () => {
  it('[US3.2/AC3.2.1] 作成の直後に、ロビーで進行役の復帰コードを一度だけ示す', async () => {
    const api = fakeApi();
    renderAt('/new', api);
    await userEvent.click(screen.getByRole('button', { name: '作成する' }));
    const note = await screen.findByRole('note', { name: '復帰コード' });
    expect(note).toHaveTextContent('RECOVER-FAC');
    expect(note).toHaveTextContent('この画面でだけ表示');
  });

  it('[US3.2/AC3.2.1] 参加の直後に、ロビーで自分の復帰コードを示す', async () => {
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
    expect(
      await screen.findByRole('note', { name: '復帰コード' }),
    ).toHaveTextContent('RECOVER-P1');
  });

  it('ロビーを直接開いたときは、復帰コードを示さない', async () => {
    renderAt('/games/g1/lobby', fakeApi());
    await screen.findByText('ABCD2345');
    expect(screen.queryByRole('note', { name: '復帰コード' })).toBeNull();
  });

  it('[US3.2/AC3.2.1] 参加者は復帰コードで戻り、進行中なら自分の画面へ進む', async () => {
    const api = fakeApi();
    renderAt('/join', api);
    await userEvent.type(screen.getByLabelText('復帰コード'), ' RECOVER-P1 ');
    await userEvent.click(screen.getByRole('button', { name: '復帰する' }));
    expect(api.recover).toHaveBeenCalledWith('RECOVER-P1');
    expect(
      await screen.findByRole('heading', { name: '小売店の画面' }),
    ).toBeInTheDocument();
  });

  it('[US3.2/AC3.2.4] 進行役は復帰コードで戻り、進行中なら進行役コンソールへ進む', async () => {
    const api = fakeApi({
      recover: vi.fn().mockResolvedValue({
        gameId: 'g1',
        kind: 'FACILITATOR',
        gameStatus: 'STARTED',
      }),
    });
    renderAt('/join', api);
    await userEvent.type(screen.getByLabelText('復帰コード'), 'RECOVER-FAC');
    await userEvent.click(screen.getByRole('button', { name: '復帰する' }));
    expect(
      await screen.findByRole('heading', { name: '進行役コンソール' }),
    ).toBeInTheDocument();
  });

  it('[US3.2/AC3.2.2] 無効な復帰コードは、進行役への確認方法を示し、入力を保持する', async () => {
    const api = fakeApi({
      recover: vi
        .fn()
        .mockRejectedValue(
          new ApiError(401, '復帰コードが無効です。進行役に確認してください'),
        ),
    });
    renderAt('/join', api);
    await userEvent.type(screen.getByLabelText('復帰コード'), 'WRONG');
    await userEvent.click(screen.getByRole('button', { name: '復帰する' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('進行役');
    expect(screen.getByLabelText('復帰コード')).toHaveValue('WRONG');
  });
});

describe('停止・再開（コンソール）', () => {
  it('[US3.1/AC3.1.1] 進行中は、確認を経て停止できる', async () => {
    const api = fakeApi();
    renderAt('/games/g1/console', api);
    await userEvent.click(
      await screen.findByRole('button', { name: '停止する' }),
    );
    const dialog = screen.getByRole('dialog', { name: '停止の確認' });
    await userEvent.click(
      within(dialog).getByRole('button', { name: '停止する' }),
    );
    expect(api.pause).toHaveBeenCalledWith('g1');
  });

  it('[US3.1/AC3.1.3] 停止中は「停止中」と示し、確定できず、確認を経て再開できる', async () => {
    const api = fakeApi({
      console: vi.fn().mockResolvedValue(consoleView({ status: 'PAUSED' })),
    });
    renderAt('/games/g1/console', api);
    expect(
      await screen.findByText(/停止中。参加者は入力できません/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '週を確定する' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '停止する' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '再開する' }));
    const dialog = screen.getByRole('dialog', { name: '再開の確認' });
    await userEvent.click(
      within(dialog).getByRole('button', { name: '再開する' }),
    );
    expect(api.resume).toHaveBeenCalledWith('g1');
  });
});

describe('代理入力（コンソール）', () => {
  it('[US3.1/AC3.1.2] 役割と数量を選び、確認を経て、その役割の版つきで代理入力する', async () => {
    const api = fakeApi();
    renderAt('/games/g1/console', api);
    const form = await screen.findByRole('form', { name: '代理入力' });
    await userEvent.selectOptions(
      within(form).getByLabelText('役割'),
      'WHOLESALER',
    );
    await userEvent.type(within(form).getByLabelText('数量'), '6');
    await userEvent.click(
      within(form).getByRole('button', { name: '代理入力を確認' }),
    );
    const dialog = screen.getByRole('dialog', { name: '代理入力の確認' });
    expect(dialog).toHaveTextContent('二次卸');
    expect(dialog).toHaveTextContent('6');
    expect(dialog).toHaveTextContent('記録');
    await userEvent.click(
      within(dialog).getByRole('button', { name: '代理入力する' }),
    );
    expect(api.proxyDecision).toHaveBeenCalledWith('g1', 'WHOLESALER', 6, 0);
  });

  it('数量が整数でなければ、確認に進まず修正方法を示す', async () => {
    const api = fakeApi();
    renderAt('/games/g1/console', api);
    const form = await screen.findByRole('form', { name: '代理入力' });
    await userEvent.type(within(form).getByLabelText('数量'), '1.5');
    await userEvent.click(
      within(form).getByRole('button', { name: '代理入力を確認' }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('0 以上の整数');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('資格の再発行（コンソール）', () => {
  it('[US3.2/AC3.2.5] 参加者を選び、確認を経て再発行すると、新しい復帰コードを示す', async () => {
    const api = fakeApi();
    renderAt('/games/g1/console', api);
    const form = await screen.findByRole('form', { name: '資格の再発行' });
    await userEvent.selectOptions(within(form).getByLabelText('対象'), 'p1');
    await userEvent.click(
      within(form).getByRole('button', { name: '失効して再発行' }),
    );
    const dialog = screen.getByRole('dialog', { name: '再発行の確認' });
    expect(dialog).toHaveTextContent('花子');
    await userEvent.click(
      within(dialog).getByRole('button', { name: '失効して再発行' }),
    );
    expect(api.reissue).toHaveBeenCalledWith('g1', {
      kind: 'PARTICIPANT',
      participantId: 'p1',
    });
    expect(
      await screen.findByRole('note', { name: '新しい復帰コード' }),
    ).toHaveTextContent('NEW-CODE');
  });

  it('[US3.2/AC3.2.5] 進行役自身の資格も再発行できる', async () => {
    const api = fakeApi();
    renderAt('/games/g1/console', api);
    const form = await screen.findByRole('form', { name: '資格の再発行' });
    await userEvent.selectOptions(
      within(form).getByLabelText('対象'),
      'FACILITATOR',
    );
    await userEvent.click(
      within(form).getByRole('button', { name: '失効して再発行' }),
    );
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: '失効して再発行',
      }),
    );
    expect(api.reissue).toHaveBeenCalledWith('g1', { kind: 'FACILITATOR' });
  });
});

describe('停止中のプレイ', () => {
  it('[US3.1/AC3.1.1] 停止中は「停止中」と示し、保存できない', async () => {
    const api = fakeApi({
      me: vi.fn().mockResolvedValue(
        roleView('RETAILER', {
          status: 'PAUSED',
          decision: { quantity: 6, version: 1, savedBy: '花子' },
        }),
      ),
    });
    renderAt('/games/g1/play', api);
    expect(
      await screen.findByText('停止中です。進行役の再開を待ってください。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存する' })).toBeDisabled();
    expect(screen.getByLabelText('発注数')).toBeDisabled();
    expect(screen.getByLabelText('発注数')).toHaveValue(6);
  });
});

describe('複数のタブ', () => {
  it('[US3.2/AC3.2.3] 再取得が重なったとき、遅れて届いた古い応答を適用せず、最新の状態を表示する', async () => {
    let notify: () => void = () => {};
    let resolveOld: (v: unknown) => void = () => {};
    const me = vi
      .fn()
      // 1 回目（古い）: 遅れて届く
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      // 2 回目（新しい）: 他のタブで週が確定した後の状態
      .mockResolvedValueOnce(roleView('RETAILER', { week: 4 }));
    const api = fakeApi({
      me,
      subscribe: vi.fn().mockImplementation((_id, onChange) => {
        notify = onChange;
        return () => {};
      }),
    });
    renderAt('/games/g1/play', api);
    notify();
    expect(await screen.findByText('4 週目')).toBeInTheDocument();
    resolveOld(roleView('RETAILER', { week: 3 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('4 週目')).toBeInTheDocument();
    expect(screen.queryByText('3 週目')).toBeNull();
  });

  it('[US3.2/AC3.2.3] 他のタブで更新された後の保存は、古い版として拒否され、黙って上書きしない', async () => {
    const api = fakeApi({
      saveDecision: vi
        .fn()
        .mockRejectedValue(
          new ApiError(409, '他の操作で更新されています。最新の発注は 8 です'),
        ),
    });
    renderAt('/games/g1/play', api);
    await userEvent.type(await screen.findByLabelText('発注数'), '5');
    await userEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '最新の発注は 8',
    );
    expect(screen.getByLabelText('発注数')).toHaveValue(5);
  });
});

describe('共同入力（プレイ）', () => {
  const coView = (extra: object = {}) =>
    roleView('RETAILER', {
      coHolders: ['花子', '太郎'],
      decision: { quantity: 8, version: 2, savedBy: '太郎' },
      ...extra,
    });

  it('[US2.1/AC2.1.4] 共同担当の一覧と、現在の入力値・保存者・版を示す', async () => {
    renderAt(
      '/games/g1/play',
      fakeApi({ me: vi.fn().mockResolvedValue(coView()) }),
    );
    expect(await screen.findByText('共同担当: 花子、太郎')).toBeInTheDocument();
    expect(
      screen.getByText('現在の入力: 8（太郎さんが保存、版 2）'),
    ).toBeInTheDocument();
  });

  it('担当が 1 人なら、共同担当を表示しない', async () => {
    renderAt(
      '/games/g1/play',
      fakeApi({
        me: vi.fn().mockResolvedValue(coView({ coHolders: ['花子'] })),
      }),
    );
    await screen.findByText(/現在の入力/);
    expect(screen.queryByText(/共同担当/)).toBeNull();
  });

  it('[US2.2/AC2.2.4] 他の担当の保存が通知されると、同じ値と版に更新される', async () => {
    let notify: () => void = () => {};
    const me = vi
      .fn()
      .mockResolvedValueOnce(coView())
      .mockResolvedValue(
        coView({ decision: { quantity: 11, version: 3, savedBy: '花子' } }),
      );
    renderAt(
      '/games/g1/play',
      fakeApi({
        me,
        subscribe: vi.fn().mockImplementation((_id, onChange) => {
          notify = onChange;
          return () => {};
        }),
      }),
    );
    await screen.findByText(/現在の入力: 8/);
    notify();
    expect(
      await screen.findByText('現在の入力: 11（花子さんが保存、版 3）'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('発注数')).toHaveValue(11);
  });

  it('[US2.2/AC2.2.3] 競合すると、最新の入力と自分の未保存の値を並べ、自分の値を保持する', async () => {
    const saveDecision = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, '他の操作で更新されています', [], {
          quantity: 9,
          version: 3,
          savedBy: '太郎',
        }),
      )
      .mockResolvedValue({ version: 4 });
    const api = fakeApi({
      me: vi.fn().mockResolvedValue(coView()),
      saveDecision,
    });
    renderAt('/games/g1/play', api);
    const input = await screen.findByLabelText('発注数');
    await userEvent.clear(input);
    await userEvent.type(input, '10');
    await userEvent.click(screen.getByRole('button', { name: '保存する' }));
    const conflict = await screen.findByRole('alert', { name: '入力の競合' });
    expect(conflict).toHaveTextContent('他の人が先に保存しました');
    expect(conflict).toHaveTextContent('最新の入力: 9（太郎さん、版 3）');
    expect(conflict).toHaveTextContent('あなたの入力: 10（未保存）');
    expect(screen.getByLabelText('発注数')).toHaveValue(10);
    // この値で保存し直すと、最新の版で保存する
    await userEvent.click(
      within(conflict).getByRole('button', { name: 'この値で保存し直す' }),
    );
    expect(saveDecision).toHaveBeenLastCalledWith('g1', 'RETAILER', 10, 3);
  });

  it('[US2.2/AC2.2.3] 「最新の値を使う」を選ぶと、自分の値を捨てて最新の値を表示する', async () => {
    const api = fakeApi({
      me: vi.fn().mockResolvedValue(coView()),
      saveDecision: vi.fn().mockRejectedValue(
        new ApiError(409, '他の操作で更新されています', [], {
          quantity: 8,
          version: 2,
          savedBy: '太郎',
        }),
      ),
    });
    renderAt('/games/g1/play', api);
    const input = await screen.findByLabelText('発注数');
    await userEvent.clear(input);
    await userEvent.type(input, '10');
    await userEvent.click(screen.getByRole('button', { name: '保存する' }));
    const conflict = await screen.findByRole('alert', { name: '入力の競合' });
    await userEvent.click(
      within(conflict).getByRole('button', { name: '最新の値を使う' }),
    );
    expect(screen.queryByRole('alert', { name: '入力の競合' })).toBeNull();
    expect(screen.getByLabelText('発注数')).toHaveValue(8);
  });
});
