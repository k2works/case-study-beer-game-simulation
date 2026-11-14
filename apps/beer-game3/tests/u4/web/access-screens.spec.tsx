// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/web/App.js';
import { ApiError, type ObserverView } from '../../../src/web/api.js';
import { PlayScreen } from '../../../src/web/screens/PlayScreen.js';
import {
  fakeApi,
  memoryStorage,
  participantCredential,
  participantState,
  problem,
} from '../../u1/web/support.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const observerCredential = { kind: 'observer' as const, secret: 'obs_abc', gameId: 'g1' };

function observerState(overrides: Partial<ObserverView> = {}): ObserverView {
  return {
    viewerKind: 'observer',
    gameId: 'g1',
    name: '授業',
    status: 'running',
    currentWeek: 3,
    weekCount: 12,
    setupKind: 'custom',
    version: 5,
    inputsDone: 2,
    teamWeeklyCost: 21000,
    teamCumulativeCost: 64000,
    teamInventory: 40,
    teamBacklog: 6,
    ...overrides,
  };
}

describe('US2.9 観察者の入口と観察画面', () => {
  it('BR15.4 参加画面の「観察者として見る」から、ラベル付きの入力欄にコードを入れて入れる。コードは保存し、URL に出さない', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      me: async () => ({ kind: 'observer', gameId: 'g1' }),
      getState: async () => observerState(),
    });
    const storage = memoryStorage();
    render(<App api={api} storage={storage} pollMs={1000} />);

    expect(await screen.findByRole('heading', { name: '観察者として見る' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('観察者用コード'), 'obs_abc');
    await user.click(screen.getByTestId('observer-enter'));

    expect(await screen.findByTestId('observer-view')).toBeInTheDocument();
    expect(storage.saved).toEqual(observerCredential);
    expect(window.location.href).not.toContain('obs_abc');
    expect(api.me).toHaveBeenCalledWith('obs_abc');
  });

  it('BR15.4 無効なコードは理由を示し、保存しない（観察者の入口の文言）', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      me: async () => {
        throw problem({
          kind: 'forbidden',
          reason: 'この資格情報は使えません',
          hint: '入り直してください',
        });
      },
    });
    const storage = memoryStorage();
    render(<App api={api} storage={storage} pollMs={1000} />);
    await user.type(await screen.findByLabelText('観察者用コード'), 'obs_wrong');
    await user.click(screen.getByTestId('observer-enter'));
    expect(await screen.findByTestId('observer-error')).toHaveTextContent(
      '観察者用コードが正しくありません',
    );
    expect(storage.saved).toBeNull();
  });

  it('AC2.9.1 観察画面は、現在週・状態・入力数とチーム全体の合計を表で示し、入力欄を持たない', async () => {
    const api = fakeApi({
      me: async () => ({ kind: 'observer', gameId: 'g1' }),
      getState: async () => observerState(),
    });
    render(<App api={api} storage={memoryStorage(observerCredential)} pollMs={1000} />);
    expect(await screen.findByTestId('observer-view')).toBeInTheDocument();
    expect(screen.getByTestId('observer-week')).toHaveTextContent('第 3 週 / 12');
    expect(screen.getByTestId('observer-status')).toHaveTextContent('進行中');
    expect(screen.getByTestId('observer-inputs')).toHaveTextContent('4 役割のうち 2 が入力済み');
    expect(screen.getByTestId('observer-cost-total')).toHaveTextContent('640');
    expect(screen.getByTestId('observer-inventory')).toHaveTextContent('40');
    expect(screen.getByTestId('observer-backlog')).toHaveTextContent('6');
    expect(screen.getByRole('table', { name: 'チーム全体の合計' })).toBeInTheDocument();
    // 入力できない
    expect(screen.queryByTestId('decision-input')).toBeNull();
    expect(screen.queryByTestId('decision-submit')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('準備中や終了後も観察画面を示す（ロビーや役割別の画面には切り替わらない）', async () => {
    const api = fakeApi({
      me: async () => ({ kind: 'observer', gameId: 'g1' }),
      getState: async () =>
        observerState({ status: 'preparing', currentWeek: 1, teamInventory: 48 }),
    });
    render(<App api={api} storage={memoryStorage(observerCredential)} pollMs={1000} />);
    expect(await screen.findByTestId('observer-status')).toHaveTextContent('準備中');
  });
});

describe('US2.1 小売店の顧客需要の表示', () => {
  const mount = (state: ReturnType<typeof participantState>) =>
    render(
      <PlayScreen
        api={fakeApi()}
        credential={participantCredential}
        state={state}
        refresh={() => undefined}
      />,
    );

  it('AC2.1.1 小売店の画面に、第 1 週から当週までの顧客需要の一覧が出る', () => {
    mount(participantState({ currentWeek: 3, customerDemand: [8, 4, 4] }));
    const demand = screen.getByTestId('customer-demand');
    expect(demand).toHaveTextContent('第 1 週');
    expect(demand).toHaveTextContent('8');
    expect(demand).toHaveTextContent('第 3 週');
    expect(demand).not.toHaveTextContent('第 4 週');
    expect(screen.getByRole('table', { name: '顧客需要' })).toBeInTheDocument();
  });

  it('AC2.1.2 顧客需要の項目が無い投影（小売店以外）では、一覧を出さない', () => {
    mount(
      participantState({ role: 'factory', mine: { ...participantState().mine!, role: 'factory' } }),
    );
    expect(screen.queryByTestId('customer-demand')).toBeNull();
  });

  it('需要が空（準備中の投影）なら、一覧を出さない', () => {
    mount(participantState({ customerDemand: [] }));
    expect(screen.queryByTestId('customer-demand')).toBeNull();
  });
});

describe('BR20.3 切断中の画面', () => {
  it('取り直しに失敗している間は「接続が切れています。自動で再接続を試みます」を示し、入力欄の値を残し、ブラウザには保存しない。成功したら消える', async () => {
    const user = userEvent.setup();
    let fail = false;
    const api = fakeApi({
      me: async () => ({ kind: 'participant', gameId: 'g1' }),
      getState: async () => {
        if (fail) {
          throw new ApiError('network', null, '通信できませんでした');
        }
        return participantState();
      },
    });
    render(<App api={api} storage={memoryStorage(participantCredential)} pollMs={20} />);
    const input = await screen.findByTestId('decision-input');
    await user.type(input, '7');
    fail = true;
    const banner = await screen.findByTestId('connection-lost');
    expect(banner).toHaveTextContent('接続が切れています。自動で再接続を試みます');
    expect(banner).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('decision-input')).toHaveValue('7');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    fail = false;
    await waitFor(() => expect(screen.queryByTestId('connection-lost')).toBeNull());
    expect(screen.getByTestId('decision-input')).toHaveValue('7');
  });

  it('送信に失敗しても入力欄の値は残る', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      me: async () => ({ kind: 'participant', gameId: 'g1' }),
      getState: async () => participantState(),
      submitDecision: async () => {
        throw new ApiError('network', null, '通信できませんでした');
      },
    });
    render(<App api={api} storage={memoryStorage(participantCredential)} pollMs={1000} />);
    const input = await screen.findByTestId('decision-input');
    await user.type(input, '9');
    await user.click(screen.getByTestId('decision-submit'));
    expect(await screen.findByText(/通信できませんでした/)).toBeInTheDocument();
    expect(screen.getByTestId('decision-input')).toHaveValue('9');
    expect(localStorage.length).toBe(0);
  });
});

describe('BR17.3 無効な資格情報を受けたとき', () => {
  const forbidden = () =>
    problem({ kind: 'forbidden', reason: 'この資格情報は使えません', hint: '入り直してください' });

  it('参加者の token が使えないとき、保存した token を消して参加画面に戻り、進行役への依頼を案内する', async () => {
    const api = fakeApi({
      me: async () => ({ kind: 'participant', gameId: 'g1' }),
      getState: async () => {
        throw forbidden();
      },
    });
    const storage = memoryStorage(participantCredential);
    render(<App api={api} storage={storage} pollMs={1000} />);
    const notice = await screen.findByTestId('credential-notice');
    expect(notice).toHaveTextContent('この端末の参加情報は使えません');
    expect(notice).toHaveTextContent('進行役に担当者の入れ替えを依頼してください');
    expect(storage.saved).toBeNull();
    expect(screen.getByTestId('join-submit')).toBeInTheDocument();
  });

  it('観察者用コードが使えないとき、観察者の入口の文言で案内する', async () => {
    const api = fakeApi({
      me: async () => ({ kind: 'observer', gameId: 'g1' }),
      getState: async () => {
        throw forbidden();
      },
    });
    const storage = memoryStorage(observerCredential);
    render(<App api={api} storage={storage} pollMs={1000} />);
    const notice = await screen.findByTestId('credential-notice');
    expect(notice).toHaveTextContent('観察者用コードが正しくありません');
    expect(storage.saved).toBeNull();
  });
});

describe('BR18.2 参加の制限中の表示', () => {
  it('429 のとき、理由と「しばらく待ってからやり直してください」を示し、入力した値は残る', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      join: async () => {
        throw problem({
          kind: 'rate_limited',
          reason: '参加の試行が続いたため、いったん受け付けられません',
          hint: 'しばらく待ってからやり直してください',
        });
      },
    });
    render(<App api={api} storage={memoryStorage()} pollMs={1000} />);
    await user.type(await screen.findByTestId('join-code'), 'ABCD2345');
    await user.type(screen.getByTestId('join-name'), '太郎');
    await user.click(screen.getByTestId('join-submit'));
    expect(await screen.findByText(/しばらく待ってからやり直してください/)).toBeInTheDocument();
    expect(screen.getByTestId('join-code')).toHaveValue('ABCD2345');
  });
});
