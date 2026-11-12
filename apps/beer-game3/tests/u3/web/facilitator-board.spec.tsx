// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { FacilitatorBoard } from '../../../src/web/screens/FacilitatorBoard.js';
import type { GameStateView } from '../../../src/web/api.js';
import { facilitatorCredential, facilitatorState, fakeApi, problem } from '../../u1/web/support.js';

afterEach(cleanup);

const person = (n: number, name: string) => ({
  participantId: `p${n}`,
  displayName: name,
  joinOrder: n,
  label: `${name} #${n}`,
  replaced: false,
});

function boardState(overrides: Partial<GameStateView> = {}): GameStateView {
  return facilitatorState({
    participants: [person(1, '工場長'), person(2, '一次'), person(3, '二次'), person(4, '店長')],
    assignees: [
      { participantId: 'p1', label: '工場長 #1', role: 'factory' },
      { participantId: 'p2', label: '一次 #2', role: 'wholesaler1' },
      { participantId: 'p3', label: '二次 #3', role: 'wholesaler2' },
      { participantId: 'p4', label: '店長 #4', role: 'retailer' },
    ],
    assignments: [
      { participantId: 'p1', role: 'factory' },
      { participantId: 'p2', role: 'wholesaler1' },
      { participantId: 'p3', role: 'wholesaler2' },
      { participantId: 'p4', role: 'retailer' },
    ],
    ...overrides,
  });
}

function renderBoard(state: GameStateView, api = fakeApi()) {
  const refresh = () => undefined;
  render(
    <FacilitatorBoard
      api={api}
      credential={facilitatorCredential}
      state={state}
      refresh={refresh}
    />,
  );
  return api;
}

describe('S4 進行管理（US2.8）', () => {
  it('AC2.8.1 4 役割の入力完了状況と現在の状態を示し、未入力を目立たせ、入力値は示さない', () => {
    renderBoard(boardState());
    const missing = screen.getByTestId('role-row-wholesaler2');
    expect(missing).toHaveTextContent('未入力');
    expect(missing).toHaveAttribute('data-missing', 'true');
    expect(screen.getByTestId('role-row-factory')).toHaveTextContent('入力済み');
    expect(screen.getByTestId('role-row-factory')).toHaveAttribute('data-missing', 'false');
    expect(screen.getByTestId('role-row-factory')).toHaveTextContent('工場長 #1');
    expect(screen.queryByText('入力値')).toBeNull();
    expect(screen.getByTestId('input-missing')).toHaveTextContent('二次卸');
  });

  it('BR12.4 同名の担当者も「表示名 #参加順」で区別して示す', () => {
    renderBoard(
      boardState({
        assignees: [
          { participantId: 'p1', label: '太郎 #1', role: 'retailer' },
          { participantId: 'p9', label: '太郎 #9', role: 'retailer' },
        ],
      }),
    );
    const row = screen.getByTestId('role-row-retailer');
    expect(row).toHaveTextContent('太郎 #1');
    expect(row).toHaveTextContent('太郎 #9');
  });
});

describe('一時停止・再開・終了（US2.5）', () => {
  it('進行中は一時停止を押せる。押すと API を呼ぶ', async () => {
    const api = fakeApi({ pause: async () => boardState({ status: 'paused' }) });
    renderBoard(boardState(), api);
    expect(screen.getByTestId('game-status')).toHaveTextContent('進行中');
    await userEvent.click(screen.getByTestId('pause-game'));
    expect(api.pause).toHaveBeenCalledWith(facilitatorCredential);
  });

  it('AC2.5.1 一時停止中は「一時停止中」を示し、再開を押せ、週の確定と代理入力は使えない', async () => {
    const api = fakeApi({ resume: async () => boardState() });
    renderBoard(boardState({ status: 'paused', missingInputRoles: [] }), api);
    expect(screen.getByTestId('game-status')).toHaveTextContent('一時停止中');
    expect(screen.queryByTestId('pause-game')).toBeNull();
    expect(screen.getByTestId('confirm-week')).toBeDisabled();
    expect(screen.queryByTestId('proxy-input-factory')).toBeNull();
    await userEvent.click(screen.getByTestId('resume-game'));
    expect(api.resume).toHaveBeenCalledWith(facilitatorCredential);
  });

  it('終了は確認を挟み、やめると API を呼ばない。確認すると終了の API を呼ぶ', async () => {
    const api = fakeApi({ end: async () => boardState({ status: 'ended' }) });
    renderBoard(boardState(), api);
    await userEvent.click(screen.getByTestId('end-game'));
    await userEvent.click(screen.getByTestId('end-game-cancel'));
    expect(api.end).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('end-game'));
    await userEvent.click(screen.getByTestId('end-game-yes'));
    expect(api.end).toHaveBeenCalledWith(facilitatorCredential);
  });

  it('終了後は操作のボタンを出さず、「終了」を示す', () => {
    renderBoard(boardState({ status: 'ended' }));
    expect(screen.getByTestId('game-status')).toHaveTextContent('終了');
    for (const id of ['pause-game', 'resume-game', 'end-game', 'confirm-week']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it('操作が失敗したら、理由と直し方を示す', async () => {
    const api = fakeApi({
      pause: async () => {
        throw problem({
          kind: 'state',
          reason: 'すでに一時停止中です',
          hint: '状態を取り直してください',
        });
      },
    });
    renderBoard(boardState(), api);
    await userEvent.click(screen.getByTestId('pause-game'));
    expect(await screen.findByRole('alert')).toHaveTextContent('すでに一時停止中です');
  });
});

describe('代理入力（US2.7）', () => {
  it('役割を選んで値を入力すると、進行役の資格情報で入力の API を呼ぶ', async () => {
    const api = fakeApi({
      submitDecision: async () => ({ week: 1, role: 'factory', quantity: 8, version: 2 }),
    });
    renderBoard(boardState(), api);
    await userEvent.type(screen.getByTestId('proxy-input-factory'), '8');
    await userEvent.click(screen.getByTestId('proxy-submit-factory'));
    expect(api.submitDecision).toHaveBeenCalledTimes(1);
    const args = api.submitDecision.mock.calls[0]!;
    expect(args.slice(0, 4)).toEqual([facilitatorCredential, 1, 'factory', 8]);
    expect(String(args[4]).length).toBeGreaterThanOrEqual(16);
    expect(await screen.findByTestId('proxy-result-factory')).toHaveTextContent('工場');
  });

  it('範囲外の値は送らず、理由を示す', async () => {
    const api = fakeApi();
    renderBoard(boardState(), api);
    await userEvent.type(screen.getByTestId('proxy-input-retailer'), '10000');
    await userEvent.click(screen.getByTestId('proxy-submit-retailer'));
    expect(await screen.findByRole('alert')).toHaveTextContent('9999');
    expect(api.submitDecision).not.toHaveBeenCalled();
  });
});

describe('担当者の入れ替え（US2.6）', () => {
  it('表示名を入れて入れ替えると、新しい復帰用 token を一度だけ示し、閉じると画面から消える', async () => {
    const api = fakeApi({
      replaceAssignee: async () => ({
        gameId: 'g1',
        role: 'retailer' as const,
        participantId: 'p9',
        displayName: '新人',
        joinOrder: 5,
        label: '新人 #5',
        replacedParticipantId: 'p4',
        token: 'tok_SECRETVALUE',
      }),
    });
    renderBoard(boardState(), api);
    await userEvent.click(screen.getByTestId('replace-open-p4'));
    await userEvent.type(screen.getByTestId('replace-name'), '新人');
    await userEvent.click(screen.getByTestId('replace-submit'));
    expect(api.replaceAssignee).toHaveBeenCalledWith(
      facilitatorCredential,
      'retailer',
      'p4',
      '新人',
    );
    const dialog = await screen.findByTestId('replacement-token');
    expect(within(dialog).getByText('tok_SECRETVALUE')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('新人 #5');
    expect(dialog).toHaveTextContent('もう一度は表示されません');
    await userEvent.click(screen.getByTestId('replacement-token-close'));
    expect(screen.queryByText('tok_SECRETVALUE')).toBeNull();
  });

  it('入れ替えの token は localStorage にも sessionStorage にも置かない', async () => {
    const api = fakeApi({
      replaceAssignee: async () => ({
        gameId: 'g1',
        role: 'retailer' as const,
        participantId: 'p9',
        displayName: '新人',
        joinOrder: 5,
        label: '新人 #5',
        replacedParticipantId: 'p4',
        token: 'tok_SECRETVALUE',
      }),
    });
    renderBoard(boardState(), api);
    await userEvent.click(screen.getByTestId('replace-open-p4'));
    await userEvent.type(screen.getByTestId('replace-name'), '新人');
    await userEvent.click(screen.getByTestId('replace-submit'));
    await screen.findByTestId('replacement-token');
    expect(JSON.stringify({ ...localStorage })).not.toContain('tok_SECRETVALUE');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('tok_SECRETVALUE');
  });

  it('表示名が空なら送らない。競合（すでに入れ替え済み）は理由と直し方を示す', async () => {
    const api = fakeApi({
      replaceAssignee: async () => {
        throw problem({
          kind: 'conflict',
          reason: '指定の担当者は、すでに入れ替え済みです',
          hint: '担当者一覧を取り直してください',
        });
      },
    });
    renderBoard(boardState(), api);
    await userEvent.click(screen.getByTestId('replace-open-p1'));
    await userEvent.click(screen.getByTestId('replace-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('表示名');
    expect(api.replaceAssignee).not.toHaveBeenCalled();
    await userEvent.type(screen.getByTestId('replace-name'), '新人');
    await userEvent.click(screen.getByTestId('replace-submit'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('入れ替え済み'));
  });
});

describe('操作の履歴（US5.6）', () => {
  it('開くと取得し、種類・誰が・いつ・何をを日本語で並べる', async () => {
    const api = fakeApi({
      getHistory: async () => ({
        entries: [
          {
            sequence: 1,
            kind: 'setting' as const,
            actorKind: 'facilitator' as const,
            occurredAt: '2026-11-12T09:00:00.000Z',
            week: null,
            role: null,
            detail: {
              weekCount: 6,
              initialInventory: 12,
              initialPipelineQuantity: 4,
              inventoryUnitCost: 50,
              backlogUnitCost: 100,
              setupKind: 'custom' as const,
              demandSeriesLength: 6,
              demandSeriesIsProvisional: true,
            },
          },
          {
            sequence: 2,
            kind: 'proxyInput' as const,
            actorKind: 'facilitator' as const,
            occurredAt: '2026-11-12T09:05:00.000Z',
            week: 1,
            role: 'factory' as const,
            detail: { value: 8 },
          },
          {
            sequence: 3,
            kind: 'end' as const,
            actorKind: 'system' as const,
            occurredAt: '2026-11-12T09:10:00.000Z',
            week: 6,
            role: null,
            detail: { reason: 'finalWeek' as const, week: 6 },
          },
        ],
      }),
    });
    renderBoard(boardState(), api);
    await userEvent.click(screen.getByTestId('history-toggle'));
    const table = await screen.findByRole('table', { name: '操作の履歴' });
    expect(api.getHistory).toHaveBeenCalledWith(facilitatorCredential);
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('設定');
    expect(rows[2]).toHaveTextContent('代理入力');
    expect(rows[2]).toHaveTextContent('工場');
    expect(rows[2]).toHaveTextContent('8');
    expect(rows[3]).toHaveTextContent('終了');
    expect(rows[3]).toHaveTextContent('システム');
  });

  it('取得に失敗したら、理由を示す', async () => {
    const api = fakeApi({
      getHistory: async () => {
        throw problem({
          kind: 'forbidden',
          reason: '履歴を見る権限がありません',
          hint: '進行役用コードで操作してください',
        });
      },
    });
    renderBoard(boardState(), api);
    await userEvent.click(screen.getByTestId('history-toggle'));
    expect(await screen.findByRole('alert')).toHaveTextContent('履歴を見る権限がありません');
  });
});
