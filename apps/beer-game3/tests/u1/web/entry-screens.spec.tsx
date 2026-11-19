// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/web/App.js';
import {
  facilitatorState,
  fakeApi,
  memoryStorage,
  participantCredential,
  participantState,
  problem,
} from './support.js';

afterEach(cleanup);

describe('S0 参加入口', () => {
  it('Given 空の入力欄 / Then 参加ボタンは押せず、押せない理由を示す。入力が入ると押せる', async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi()} storage={memoryStorage()} pollMs={1000} />);
    const submit = await screen.findByTestId('join-submit');
    expect(submit).toBeDisabled();
    expect(screen.getByText('参加コードと表示名を入力すると押せます')).toBeInTheDocument();
    await user.type(screen.getByTestId('join-code'), 'abcd-2345');
    await user.type(screen.getByTestId('join-name'), '太郎');
    expect(submit).toBeEnabled();
  });

  it('AC1.2.1 参加すると token を保存してロビーへ進み、参加者の一覧に表示名と参加順の番号が出る', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      join: async () => ({
        gameId: 'g1',
        participantId: 'p1',
        displayName: '太郎',
        joinOrder: 1,
        token: 'tok_new',
      }),
      getState: async () =>
        participantState({
          status: 'preparing',
          role: undefined,
          mine: undefined,
          participants: [{ displayName: '太郎', joinOrder: 1, label: '太郎 #1', replaced: false }],
        }),
    });
    const storage = memoryStorage();
    render(<App api={api} storage={storage} pollMs={1000} />);
    await user.type(await screen.findByTestId('join-code'), 'ABCD2345');
    await user.type(screen.getByTestId('join-name'), '太郎');
    await user.click(screen.getByTestId('join-submit'));
    expect(await screen.findByRole('heading', { name: 'ロビー' })).toBeInTheDocument();
    expect(await screen.findByText('太郎 #1')).toBeInTheDocument();
    expect(storage.saved).toEqual({ kind: 'participant', secret: 'tok_new', gameId: 'g1' });
    expect(screen.getByText('開始を待っています')).toBeInTheDocument();
  });

  it('AC1.2.2〜AC1.2.4 拒否の理由を欄の下に示し、入力した値は残る', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      join: async () => {
        throw problem({
          kind: 'state',
          reason: 'ゲームは進行中のため参加できない状態です',
          hint: '次のゲームの開始前に参加してください',
        });
      },
    });
    render(<App api={api} storage={memoryStorage()} pollMs={1000} />);
    await user.type(await screen.findByTestId('join-code'), 'ABCD2345');
    await user.type(screen.getByTestId('join-name'), '太郎');
    await user.click(screen.getByTestId('join-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('進行中のため参加できない');
    expect(screen.getByTestId('join-code')).toHaveValue('ABCD2345');
    expect(screen.getByTestId('join-name')).toHaveValue('太郎');
    expect(screen.getByTestId('join-submit')).toBeEnabled();
  });

  it('表示名の誤りは表示名の欄の下に示す', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      join: async () => {
        throw problem({
          kind: 'validation',
          reason: '参加の入力に誤りがあります',
          hint: '1〜40 文字の表示名を入力してください',
          fields: [{ path: 'displayName', message: '表示名は 40 文字以内で入力してください' }],
        });
      },
    });
    render(<App api={api} storage={memoryStorage()} pollMs={1000} />);
    await user.type(await screen.findByTestId('join-code'), 'ABCD2345');
    await user.type(screen.getByTestId('join-name'), '太郎');
    await user.click(screen.getByTestId('join-submit'));
    expect(await screen.findByText('表示名は 40 文字以内で入力してください')).toBeInTheDocument();
  });

  it('通信できないときは通信の問題として知らせる', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../../src/web/api.js');
    const api = fakeApi({
      join: async () => {
        throw new ApiError('network', null, '通信できませんでした');
      },
    });
    render(<App api={api} storage={memoryStorage()} pollMs={1000} />);
    await user.type(await screen.findByTestId('join-code'), 'ABCD2345');
    await user.type(screen.getByTestId('join-name'), '太郎');
    await user.click(screen.getByTestId('join-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('通信できませんでした');
  });

  it('進行役用コードで入ると、進行役としてゲームの画面へ進む', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      me: async () => ({ kind: 'facilitator', gameId: 'g1' }),
      getState: async () =>
        facilitatorState({ status: 'preparing', roles: undefined, missingInputRoles: [] }),
    });
    const storage = memoryStorage();
    render(<App api={api} storage={storage} pollMs={1000} />);
    await user.type(await screen.findByTestId('facilitator-code-input'), 'fac_secret');
    await user.click(screen.getByTestId('facilitator-enter'));
    expect(await screen.findByRole('heading', { name: 'ロビー' })).toBeInTheDocument();
    expect(storage.saved).toEqual({ kind: 'facilitator', secret: 'fac_secret', gameId: 'g1' });
  });

  it('無効な進行役用コードは理由を示す', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      me: async () => {
        throw problem({
          kind: 'forbidden',
          reason: 'この操作を行う権限がありません',
          hint: 'コードを確かめてください',
        });
      },
    });
    render(<App api={api} storage={memoryStorage()} pollMs={1000} />);
    await user.type(await screen.findByTestId('facilitator-code-input'), 'nope');
    await user.click(screen.getByTestId('facilitator-enter'));
    expect(await screen.findByRole('alert')).toHaveTextContent('権限がありません');
  });

  it('保存済みの token があれば、再読み込みしても同じ役割の画面に戻る', async () => {
    const api = fakeApi({
      me: async () => ({
        kind: 'participant',
        gameId: 'g1',
        participantId: 'p1',
        role: 'retailer',
      }),
      getState: async () => participantState(),
    });
    render(<App api={api} storage={memoryStorage(participantCredential)} pollMs={1000} />);
    expect(await screen.findByText('役割: 小売店')).toBeInTheDocument();
  });

  it('保存済みの資格情報が無効になっていたら、保存を消して参加入口に戻る', async () => {
    const api = fakeApi({
      me: async () => {
        throw problem({
          kind: 'forbidden',
          reason: '権限がありません',
          hint: '入り直してください',
        });
      },
    });
    const storage = memoryStorage(participantCredential);
    render(<App api={api} storage={storage} pollMs={1000} />);
    expect(await screen.findByTestId('join-submit')).toBeInTheDocument();
    expect(storage.cleared).toBe(true);
  });
});

describe('S1 ゲーム作成', () => {
  async function openCreate() {
    const user = userEvent.setup();
    const api = fakeApi();
    const storage = memoryStorage();
    render(<App api={api} storage={storage} pollMs={1000} />);
    await user.click(await screen.findByTestId('go-create'));
    return { user, api, storage };
  }

  it('AC1.1.3 遅延の週数を変える項目はなく、初期パイプライン数量の項目がある', async () => {
    await openCreate();
    expect(screen.getByRole('heading', { name: 'ゲームを作成する' })).toBeInTheDocument();
    expect(screen.getByLabelText('初期パイプライン数量')).toBeInTheDocument();
    expect(screen.getByText(/遅延の週数は固定です/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/遅延/)).toBeNull();
    expect(screen.getByText(/設定の種類: カスタム/)).toBeInTheDocument();
  });

  it('AC1.1.1 範囲外の週数は欄の下に理由を示し、入力済みの他の項目は残る', async () => {
    const { user, api } = await openCreate();
    api.createGame.mockRejectedValueOnce(
      problem({
        kind: 'validation',
        reason: 'ゲームの設定に誤りがあります',
        hint: '週数は 1〜50 の整数で入力してください',
        fields: [{ path: 'weekCount', message: '週数は 1〜50 の整数で入力してください' }],
      }),
    );
    await user.type(screen.getByTestId('create-name'), '授業');
    await user.clear(screen.getByTestId('create-weekCount'));
    await user.type(screen.getByTestId('create-weekCount'), '51');
    await user.clear(screen.getByTestId('create-initialInventory'));
    await user.type(screen.getByTestId('create-initialInventory'), '20');
    await user.click(screen.getByTestId('create-submit'));
    expect(
      await screen.findByText('週数は 1〜50 の整数で入力してください', {
        selector: '[role=alert]',
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('create-name')).toHaveValue('授業');
    expect(screen.getByTestId('create-initialInventory')).toHaveValue('20');
    expect(screen.getByTestId('create-weekCount')).toHaveValue('51');
  });

  it('入力を API の形（単価は最小単位のセント、需要系列は整数の並び）に直して送る', async () => {
    const { user, api } = await openCreate();
    api.createGame.mockResolvedValueOnce({
      gameId: 'g1',
      name: '授業',
      status: 'preparing',
      weekCount: 3,
      currentWeek: 1,
      setupKind: 'custom',
      codes: { joinCode: 'JOINCODE23', facilitatorCode: 'fac_secret', observerCode: 'obs_secret' },
    });
    await user.type(screen.getByTestId('create-name'), '授業');
    await user.clear(screen.getByTestId('create-weekCount'));
    await user.type(screen.getByTestId('create-weekCount'), '3');
    await user.type(screen.getByTestId('create-demand'), '4, 4, 8');
    await user.clear(screen.getByTestId('create-inventoryUnitCost'));
    await user.type(screen.getByTestId('create-inventoryUnitCost'), '0.5');
    await user.click(screen.getByTestId('create-submit'));
    expect(api.createGame).toHaveBeenCalledWith({
      name: '授業',
      weekCount: 3,
      initialInventory: 12,
      initialPipelineQuantity: 4,
      inventoryUnitCost: 50,
      backlogUnitCost: 100,
      demandSeries: [4, 4, 8],
    });
    // AC1.1.4 コードを 1 度だけ示す。進行役用コードは再発行しない旨を添える
    expect(
      await screen.findByRole('heading', { name: 'ゲームを作成しました' }),
    ).toBeInTheDocument();
    expect(screen.getByText('JOINCODE23')).toBeInTheDocument();
    expect(screen.getByText('fac_secret')).toBeInTheDocument();
    expect(screen.getByText(/進行役用コードは再発行できません/)).toBeInTheDocument();
  });

  it('ブラウザで検証できる誤り（数値でない・単価の形式）はその場で示し、送らない', async () => {
    const { user, api } = await openCreate();
    await user.type(screen.getByTestId('create-name'), '授業');
    await user.clear(screen.getByTestId('create-weekCount'));
    await user.type(screen.getByTestId('create-weekCount'), 'abc');
    await user.clear(screen.getByTestId('create-backlogUnitCost'));
    await user.type(screen.getByTestId('create-backlogUnitCost'), '1.234');
    await user.type(screen.getByTestId('create-demand'), '4, x, 8');
    await user.click(screen.getByTestId('create-submit'));
    expect(api.createGame).not.toHaveBeenCalled();
    expect(await screen.findAllByRole('alert')).toHaveLength(3);
  });

  it('作成後、ロビーへ進むと進行役用コードをこのタブに保存して進行役の画面になる', async () => {
    const { user, api, storage } = await openCreate();
    api.createGame.mockResolvedValueOnce({
      gameId: 'g1',
      name: '授業',
      status: 'preparing',
      weekCount: 5,
      currentWeek: 1,
      setupKind: 'custom',
      codes: { joinCode: 'JOINCODE23', facilitatorCode: 'fac_secret', observerCode: 'obs_secret' },
    });
    api.getState.mockResolvedValue(
      facilitatorState({
        status: 'preparing',
        roles: undefined,
        missingInputRoles: [],
        participants: [],
        unassignedRoles: ['factory', 'wholesaler1', 'wholesaler2', 'retailer'],
      }),
    );
    await user.type(screen.getByTestId('create-name'), '授業');
    await user.click(screen.getByTestId('create-submit'));
    await user.click(await screen.findByTestId('enter-lobby'));
    expect(await screen.findByRole('heading', { name: 'ロビー' })).toBeInTheDocument();
    expect(storage.saved).toEqual({ kind: 'facilitator', secret: 'fac_secret', gameId: 'g1' });
    await waitFor(() => expect(api.getState).toHaveBeenCalled());
  });
});
