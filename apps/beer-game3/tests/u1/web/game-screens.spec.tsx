// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/web/App.js';
import { ApiError } from '../../../src/web/api.js';
import {
  facilitatorCredential,
  facilitatorState,
  fakeApi,
  memoryStorage,
  participantCredential,
  participantState,
  problem,
} from './support.js';

afterEach(cleanup);

const meParticipant = async () => ({
  kind: 'participant' as const,
  gameId: 'g1',
  participantId: 'p1',
  role: 'retailer' as const,
});
const meFacilitator = async () => ({ kind: 'facilitator' as const, gameId: 'g1' });

describe('S2 ロビー', () => {
  it('進行役: 参加者を参加順の番号つきで示し、同名でも区別でき、表示名はスクリプトとして実行されない', async () => {
    const api = fakeApi({
      me: meFacilitator,
      getState: async () =>
        facilitatorState({
          status: 'preparing',
          roles: undefined,
          missingInputRoles: [],
          participants: [
            {
              participantId: 'p1',
              displayName: '太郎',
              joinOrder: 1,
              label: '太郎 #1',
              replaced: false,
            },
            {
              participantId: 'p2',
              displayName: '太郎',
              joinOrder: 2,
              label: '太郎 #2',
              replaced: false,
            },
            {
              participantId: 'p3',
              displayName: '<script>alert(1)</script>',
              joinOrder: 3,
              label: '<script>alert(1)</script> #3',
              replaced: false,
            },
          ],
          unassignedRoles: ['factory', 'wholesaler1', 'wholesaler2', 'retailer'],
        }),
    });
    const { container } = render(
      <App api={api} storage={memoryStorage(facilitatorCredential)} pollMs={1000} />,
    );
    expect(await screen.findByText('太郎 #1')).toBeInTheDocument();
    expect(screen.getByText('太郎 #2')).toBeInTheDocument();
    expect(screen.getByText('<script>alert(1)</script> #3')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(await screen.findByText('JOINCODE23')).toBeInTheDocument();
  });

  it('AC1.3.1 4 役割がそろわない間は開始を押せず、未割当ての役割を文章で示す', async () => {
    const api = fakeApi({
      me: meFacilitator,
      getState: async () =>
        facilitatorState({
          status: 'preparing',
          roles: undefined,
          missingInputRoles: [],
          assignments: [{ participantId: 'p1', role: 'factory' }],
          unassignedRoles: ['wholesaler1', 'wholesaler2', 'retailer'],
        }),
    });
    render(<App api={api} storage={memoryStorage(facilitatorCredential)} pollMs={1000} />);
    expect(await screen.findByTestId('start-blocker')).toHaveTextContent(
      '開始できません: 一次卸、二次卸、小売店の担当者がいません',
    );
    expect(screen.getByTestId('start-game')).toBeDisabled();
  });

  it('AC1.3.2 役割を選ぶと割当てを送り、すべてそろえば開始できる', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      me: meFacilitator,
      getState: async () =>
        facilitatorState({
          status: 'preparing',
          roles: undefined,
          missingInputRoles: [],
          assignments: [
            { participantId: 'p1', role: 'factory' },
            { participantId: 'p2', role: 'retailer' },
          ],
          unassignedRoles: [],
        }),
    });
    render(<App api={api} storage={memoryStorage(facilitatorCredential)} pollMs={1000} />);
    const select = await screen.findByTestId('assign-select-p2');
    await user.selectOptions(select, 'wholesaler1');
    expect(api.assign).toHaveBeenCalledWith(facilitatorCredential, 'p2', 'wholesaler1');
    await user.selectOptions(select, '');
    expect(api.assign).toHaveBeenCalledWith(facilitatorCredential, 'p2', null);
    const start = screen.getByTestId('start-game');
    expect(start).toBeEnabled();
    await user.click(start);
    expect(api.start).toHaveBeenCalledWith(facilitatorCredential);
  });

  it('割当てが拒否されたら理由を示す（定員など）', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      me: meFacilitator,
      assign: async () => {
        throw problem({
          kind: 'state',
          reason: '1 つの役割に就けるのは 4 人までです',
          hint: '別の役割に割り当ててください',
        });
      },
      getState: async () =>
        facilitatorState({
          status: 'preparing',
          roles: undefined,
          missingInputRoles: [],
          unassignedRoles: ['factory'],
        }),
    });
    render(<App api={api} storage={memoryStorage(facilitatorCredential)} pollMs={1000} />);
    await user.selectOptions(await screen.findByTestId('assign-select-p1'), 'factory');
    expect(await screen.findByRole('alert')).toHaveTextContent('4 人まで');
  });

  it('参加者: 自分の名前と割当て済みの役割と「開始を待っています」を示し、編集の操作は出さない', async () => {
    const api = fakeApi({
      me: meParticipant,
      getState: async () => participantState({ status: 'preparing', mine: undefined }),
    });
    render(<App api={api} storage={memoryStorage(participantCredential)} pollMs={1000} />);
    expect(await screen.findByText('開始を待っています')).toBeInTheDocument();
    expect(screen.getByText(/あなた: 太郎/)).toBeInTheDocument();
    expect(screen.getByText(/担当: 小売店/)).toBeInTheDocument();
    expect(screen.queryByTestId('start-game')).toBeNull();
  });

  it('1 秒おきの取り直し: 版が変わったら一覧を更新し、通信が切れたら帯で知らせて復帰したら消す', async () => {
    let calls = 0;
    let fail = false;
    const api = fakeApi({
      me: meParticipant,
      getState: async () => {
        calls += 1;
        if (fail) {
          throw new ApiError('network', null, '通信できませんでした');
        }
        return participantState({
          status: 'preparing',
          mine: undefined,
          version: calls,
          participants:
            calls < 3
              ? [{ displayName: '太郎', joinOrder: 1, label: '太郎 #1', replaced: false }]
              : [
                  { displayName: '太郎', joinOrder: 1, label: '太郎 #1', replaced: false },
                  { displayName: '花子', joinOrder: 2, label: '花子 #2', replaced: false },
                ],
        });
      },
    });
    render(<App api={api} storage={memoryStorage(participantCredential)} pollMs={20} />);
    expect(await screen.findByText('太郎 #1')).toBeInTheDocument();
    expect(await screen.findByText('花子 #2')).toBeInTheDocument();
    fail = true;
    expect(await screen.findByText(/通信が切れています/)).toBeInTheDocument();
    fail = false;
    await waitFor(() => expect(screen.queryByText(/通信が切れています/)).toBeNull());
  });
});

describe('S3 役割別プレイ（参加者）', () => {
  async function openPlay(
    overrides: Parameters<typeof participantState>[0] = {},
    apiOverrides = {},
  ) {
    const user = userEvent.setup();
    const api = fakeApi({
      me: meParticipant,
      getState: async () => participantState(overrides),
      ...apiOverrides,
    });
    render(<App api={api} storage={memoryStorage(participantCredential)} pollMs={1000} />);
    await screen.findByText('役割: 小売店');
    return { user, api };
  }

  it('当週の状況（入荷・受注・在庫・受注残）と入力欄を示し、入力欄に常に見えるラベルがある', async () => {
    await openPlay();
    expect(screen.getByText('第 1 週 / 6')).toBeInTheDocument();
    const status = screen.getByTestId('status-panel');
    expect(within(status).getByText('入荷').nextSibling).toHaveTextContent('4');
    expect(within(status).getByText('受注（今週の顧客需要）').nextSibling).toHaveTextContent('4');
    expect(within(status).getByText('在庫').nextSibling).toHaveTextContent('12');
    expect(within(status).getByText('受注残').nextSibling).toHaveTextContent('0');
    expect(screen.getByLabelText('発注数')).toBeInTheDocument();
    expect(screen.getByText('入力: 未入力')).toBeInTheDocument();
    expect(screen.getByText('ほかの役割: 4 役割のうち 0 が入力済み')).toBeInTheDocument();
  });

  it.each([
    ['2.5', '小数'],
    ['-1', '負数'],
    ['abc', '文字'],
    ['', '空欄'],
    ['10000', '上限超過'],
  ])(
    'AC1.4.2 %s（%s）は拒否し、理由を欄の下に示し、入力した値は残る。API には送らない',
    async (value) => {
      const { user, api } = await openPlay();
      const input = screen.getByTestId('decision-input');
      if (value !== '') {
        await user.type(input, value);
      }
      await user.click(screen.getByTestId('decision-submit'));
      expect(await screen.findByRole('alert')).toHaveTextContent('0 以上 9999 以下の整数');
      expect(input).toHaveValue(value);
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(api.submitDecision).not.toHaveBeenCalled();
    },
  );

  it('AC1.4.3 0 は受け付けて保存する。識別子（16 文字以上）を付けて送り、保存済みを示す', async () => {
    const { user, api } = await openPlay(
      {},
      {
        submitDecision: async () => ({ week: 1, role: 'retailer', quantity: 0, version: 5 }),
      },
    );
    await user.type(screen.getByTestId('decision-input'), '0');
    await user.click(screen.getByTestId('decision-submit'));
    await waitFor(() => expect(api.submitDecision).toHaveBeenCalledTimes(1));
    const [credential, week, role, quantity, key] = api.submitDecision.mock.calls[0]!;
    expect(credential).toEqual(participantCredential);
    expect([week, role, quantity]).toEqual([1, 'retailer', 0]);
    expect(String(key).length).toBeGreaterThanOrEqual(16);
    expect(await screen.findByText('入力: 保存済み')).toBeInTheDocument();
  });

  it('保存済みの値は取り直した状態に反映され、上書きするときは新しい識別子を使う', async () => {
    const { user, api } = await openPlay(
      { mine: { ...participantState().mine!, decision: 10 } },
      {
        submitDecision: async (_c: unknown, _w: unknown, _r: unknown, quantity: number) => ({
          week: 1,
          role: 'retailer',
          quantity,
          version: 6,
        }),
      },
    );
    expect(screen.getByTestId('decision-input')).toHaveValue('10');
    expect(screen.getByText('入力: 保存済み（10）')).toBeInTheDocument();
    const input = screen.getByTestId('decision-input');
    await user.clear(input);
    await user.type(input, '12');
    await user.click(screen.getByTestId('decision-submit'));
    await waitFor(() => expect(api.submitDecision).toHaveBeenCalledTimes(1));
    await user.clear(input);
    await user.type(input, '13');
    await user.click(screen.getByTestId('decision-submit'));
    await waitFor(() => expect(api.submitDecision).toHaveBeenCalledTimes(2));
    expect(api.submitDecision.mock.calls[0]![4]).not.toBe(api.submitDecision.mock.calls[1]![4]);
  });

  it('保存に失敗（混雑）したら理由を示し、同じ内容の再実行では同じ識別子を使う（重複して処理させない）', async () => {
    let attempts = 0;
    const { user, api } = await openPlay(
      {},
      {
        submitDecision: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw problem({
              kind: 'unavailable',
              reason: '同じゲームへの操作が重なっています',
              hint: 'しばらくして、もう一度操作してください',
            });
          }
          return { week: 1, role: 'retailer', quantity: 7, version: 7 };
        },
      },
    );
    await user.type(screen.getByTestId('decision-input'), '7');
    await user.click(screen.getByTestId('decision-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('操作が重なっています');
    await user.click(screen.getByTestId('decision-submit'));
    await waitFor(() => expect(api.submitDecision).toHaveBeenCalledTimes(2));
    expect(api.submitDecision.mock.calls[0]![4]).toBe(api.submitDecision.mock.calls[1]![4]);
    expect(await screen.findByText('入力: 保存済み')).toBeInTheDocument();
  });

  it('サーバーが入力を拒否（当週でない）したら理由を示す', async () => {
    const { user } = await openPlay(
      {},
      {
        submitDecision: async () => {
          throw problem({
            kind: 'state',
            reason: '第 1 週は入力できません（当週は第 2 週です）',
            hint: '画面を更新して、当週の入力欄から入力してください',
          });
        },
      },
    );
    await user.type(screen.getByTestId('decision-input'), '7');
    await user.click(screen.getByTestId('decision-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('当週は第 2 週');
  });

  it('工場は「生産要請数」で、受注は「一次卸からの注文」と示す（ステップ番号は同じ）', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      me: async () => ({ kind: 'participant', gameId: 'g1', participantId: 'p1', role: 'factory' }),
      getState: async () =>
        participantState({
          role: 'factory',
          mine: { ...participantState().mine!, role: 'factory' },
        }),
    });
    render(<App api={api} storage={memoryStorage(participantCredential)} pollMs={1000} />);
    expect(await screen.findByLabelText('生産要請数')).toBeInTheDocument();
    expect(screen.getByText('受注（一次卸からの注文）')).toBeInTheDocument();
    expect(screen.getByTestId('decision-submit')).toHaveTextContent('生産要請数を保存する');
    void user;
  });

  it('他の役割の状況は入力済みの数だけを示す。履歴は開閉でき、費用はドル表記になる', async () => {
    const { user } = await openPlay({
      currentWeek: 3,
      inputsDone: 3,
      mine: {
        ...participantState().mine!,
        week: 3,
        history: [
          {
            week: 1,
            receipt: 4,
            ordersReceived: 4,
            shipped: 4,
            inventory: 12,
            backlog: 0,
            decision: 4,
            weeklyCost: 600,
            cumulativeCost: 600,
          },
          {
            week: 2,
            receipt: 4,
            ordersReceived: 8,
            shipped: 8,
            inventory: 8,
            backlog: 0,
            decision: 8,
            weeklyCost: 400,
            cumulativeCost: 1000,
          },
        ],
        cumulativeCost: 1000,
      },
    });
    expect(screen.getByText('ほかの役割: 4 役割のうち 3 が入力済み')).toBeInTheDocument();
    expect(screen.getByText(/累積費用/)).toHaveTextContent('$10.00');
    await user.click(screen.getByTestId('history-toggle'));
    const table = screen.getByRole('table', { name: '履歴' });
    const rows = within(table).getAllByRole('row');
    // 見出し + 2 週分（新しい週が上）
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getAllByRole('cell')[0]).toHaveTextContent('2');
    expect(within(rows[1]!).getByText('$4.00')).toBeInTheDocument();
  });

  it('第 1 週は履歴が空であることを示し、終了後は入力欄を出さずに終了を案内する', async () => {
    const { user } = await openPlay();
    await user.click(screen.getByTestId('history-toggle'));
    expect(screen.getByText('まだ履歴がありません')).toBeInTheDocument();
    cleanup();
    const api = fakeApi({
      me: meParticipant,
      getState: async () =>
        participantState({
          status: 'ended',
          currentWeek: 6,
          mine: { ...participantState().mine!, week: 6, decision: 4 },
        }),
    });
    render(<App api={api} storage={memoryStorage(participantCredential)} pollMs={1000} />);
    expect(await screen.findByText('ゲームは終了しました')).toBeInTheDocument();
    expect(screen.queryByTestId('decision-input')).toBeNull();
  });

  it('割当て前の参加者が進行中の画面に入ったら、役割が無いことを案内する', async () => {
    const api = fakeApi({
      me: async () => ({ kind: 'participant', gameId: 'g1', participantId: 'p1', role: null }),
      getState: async () => participantState({ role: undefined, mine: undefined }),
    });
    render(<App api={api} storage={memoryStorage(participantCredential)} pollMs={1000} />);
    expect(await screen.findByText(/役割が割り当てられていません/)).toBeInTheDocument();
  });
});

describe('進行役の週の確定（最小の進行管理）', () => {
  it('AC1.5.1 未入力の役割があるとき、確定を押せず、未入力の役割を文章で示す', async () => {
    const api = fakeApi({ me: meFacilitator, getState: async () => facilitatorState() });
    render(<App api={api} storage={memoryStorage(facilitatorCredential)} pollMs={1000} />);
    expect(await screen.findByTestId('input-missing')).toHaveTextContent('未入力: 二次卸、小売店');
    expect(screen.getByTestId('confirm-week')).toBeDisabled();
    expect(screen.getByText('2 / 4 役割が入力済み')).toBeInTheDocument();
  });

  it('AC1.5.2 4 役割がそろえば確認のあと確定でき、結果（チーム費用）を示す。識別子を付けて送る', async () => {
    const user = userEvent.setup();
    const state = facilitatorState({
      inputsDone: 4,
      missingInputRoles: [],
    });
    const api = fakeApi({
      me: meFacilitator,
      getState: async () => state,
      confirmWeek: async () => ({
        week: 1,
        results: [],
        teamCost: 2400,
        status: 'running',
        currentWeek: 2,
        version: 9,
      }),
    });
    render(<App api={api} storage={memoryStorage(facilitatorCredential)} pollMs={1000} />);
    const button = await screen.findByTestId('confirm-week');
    expect(button).toBeEnabled();
    await user.click(button);
    expect(screen.getByText('第 1 週を確定します。確定後は変更できません')).toBeInTheDocument();
    await user.click(screen.getByTestId('confirm-week-cancel'));
    expect(api.confirmWeek).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('confirm-week'));
    await user.click(screen.getByTestId('confirm-week-yes'));
    await waitFor(() => expect(api.confirmWeek).toHaveBeenCalledTimes(1));
    const [credential, week, key] = api.confirmWeek.mock.calls[0]!;
    expect(credential).toEqual(facilitatorCredential);
    expect(week).toBe(1);
    expect(String(key).length).toBeGreaterThanOrEqual(16);
    expect(
      await screen.findByText(/第 1 週を確定しました（チーム費用 \$24.00）/),
    ).toBeInTheDocument();
  });

  it('確定が失敗したら、確定前の状態のままであることを示し、再実行できる', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      me: meFacilitator,
      getState: async () => facilitatorState({ inputsDone: 4, missingInputRoles: [] }),
      confirmWeek: async () => {
        throw problem({
          kind: 'internal',
          reason: 'サーバーで問題が起きました',
          hint: '少し待ってから、状態を取り直してください',
        });
      },
    });
    render(<App api={api} storage={memoryStorage(facilitatorCredential)} pollMs={1000} />);
    await user.click(await screen.findByTestId('confirm-week'));
    await user.click(screen.getByTestId('confirm-week-yes'));
    expect(await screen.findByRole('alert')).toHaveTextContent('確定前の状態のまま');
    expect(screen.getByTestId('confirm-week')).toBeEnabled();
  });

  it('4 役割の入力状況は役割別に示し、終了後は確定を出さない', async () => {
    const api = fakeApi({
      me: meFacilitator,
      getState: async () => facilitatorState({ status: 'ended', currentWeek: 6 }),
    });
    render(<App api={api} storage={memoryStorage(facilitatorCredential)} pollMs={1000} />);
    expect(await screen.findByText('ゲームは終了しました')).toBeInTheDocument();
    expect(screen.queryByTestId('confirm-week')).toBeNull();
  });

  it('役割別の表に 4 役割の入力と状況が出る', async () => {
    const api = fakeApi({ me: meFacilitator, getState: async () => facilitatorState() });
    render(<App api={api} storage={memoryStorage(facilitatorCredential)} pollMs={1000} />);
    const table = await screen.findByRole('table', { name: '役割別の状況' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(within(rows[1]!).getByText('工場')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('入力済み')).toBeInTheDocument();
    expect(within(rows[4]!).getByText('未入力')).toBeInTheDocument();
  });

  it('act の警告を出さずに終了できる（取り直しの停止）', async () => {
    const api = fakeApi({ me: meFacilitator, getState: async () => facilitatorState() });
    const { unmount } = render(
      <App api={api} storage={memoryStorage(facilitatorCredential)} pollMs={10} />,
    );
    await screen.findByTestId('confirm-week');
    unmount();
    const callsAtUnmount = api.getState.mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(api.getState.mock.calls.length).toBe(callsAtUnmount);
  });
});
