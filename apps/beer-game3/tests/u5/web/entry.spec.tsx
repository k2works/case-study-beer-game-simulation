// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObserverView } from '../../../src/web/api.js';
import { FacilitatorBoard } from '../../../src/web/screens/FacilitatorBoard.js';
import { GameScreen } from '../../../src/web/screens/GameScreen.js';
import { JoinScreen } from '../../../src/web/screens/JoinScreen.js';
import {
  facilitatorCredential,
  facilitatorState,
  fakeApi,
  participantCredential,
  participantState,
  problem,
} from '../../u1/web/support.js';
import { makeView } from './support.js';

afterEach(cleanup);

const noop = () => undefined;
const observerState = (status: ObserverView['status']): ObserverView => ({
  viewerKind: 'observer',
  gameId: 'g1',
  name: '授業',
  status,
  currentWeek: 3,
  weekCount: 3,
  setupKind: 'custom',
  version: 4,
  inputsDone: 0,
  teamWeeklyCost: 0,
  teamCumulativeCost: 0,
  teamInventory: 0,
  teamBacklog: 0,
});

function renderGame(
  state: ReturnType<typeof participantState> | ObserverView,
  credential = participantCredential,
) {
  const api = fakeApi({
    getState: async () => state,
    getResults: async () => makeView(3),
  });
  render(
    <GameScreen api={api} credential={credential} pollMs={60_000} onDenied={noop} onLeave={noop} />,
  );
  return api;
}

describe('BR22.6 終了したゲームだけ、結果画面への導線を出す', () => {
  it('参加者: 終了したら「結果を見る」が出る。押すと結果画面に移り、戻れる', async () => {
    const api = renderGame(participantState({ status: 'ended', currentWeek: 3 }));
    const button = await screen.findByTestId('show-results');
    expect(button).toHaveTextContent('結果を見る');
    await userEvent.click(button);
    expect(await screen.findByTestId('results-screen')).toBeInTheDocument();
    expect(api.getResults).toHaveBeenCalledWith(participantCredential);
    expect(screen.getByTestId('results-summary')).toHaveTextContent('授業');
    await userEvent.click(screen.getByTestId('results-back'));
    expect(await screen.findByTestId('show-results')).toBeInTheDocument();
  });

  it('進行役: 終了したら「結果を見る」が出る', async () => {
    renderGame(
      facilitatorState({ status: 'ended', currentWeek: 3, missingInputRoles: [] }),
      facilitatorCredential,
    );
    expect(await screen.findByTestId('show-results')).toBeInTheDocument();
  });

  it.each(['preparing', 'running', 'paused'] as const)(
    '%s のあいだは出さない（参加者と進行役）',
    async (status) => {
      renderGame(participantState({ status }));
      await screen.findByRole('heading', { level: 1 });
      expect(screen.queryByTestId('show-results')).toBeNull();
      cleanup();
      renderGame(facilitatorState({ status }), facilitatorCredential);
      await screen.findByRole('heading', { level: 1 });
      expect(screen.queryByTestId('show-results')).toBeNull();
    },
  );

  it('観察者には出さない（チーム全体の集計値だけを見る）', async () => {
    renderGame(observerState('ended'));
    await screen.findByTestId('observer-view');
    expect(screen.queryByTestId('show-results')).toBeNull();
  });

  it('終了前に結果を直接開こうとして 403 になったら、その理由を示す', async () => {
    const api = fakeApi({
      getState: async () => participantState({ status: 'ended' }),
      getResults: async () => {
        throw problem({
          kind: 'forbidden',
          reason: 'ゲームが終了するまで、結果は見られません',
          hint: 'ゲームが終了してから、もう一度開いてください',
        });
      },
    });
    render(
      <GameScreen
        api={api}
        credential={participantCredential}
        pollMs={60_000}
        onDenied={noop}
        onLeave={noop}
      />,
    );
    await userEvent.click(await screen.findByTestId('show-results'));
    expect(await screen.findByTestId('results-error')).toHaveTextContent(
      'ゲームが終了するまで、結果は見られません',
    );
  });
});

describe('US4.2 進行役のボードに、終了後だけ出力のボタンと説明を出す', () => {
  const board = (status: 'running' | 'ended') =>
    render(
      <FacilitatorBoard
        api={fakeApi()}
        credential={facilitatorCredential}
        state={facilitatorState({ status, missingInputRoles: [] })}
        refresh={noop}
      />,
    );

  it('終了後: CSV と JSON のボタン、注意、列名の説明が同時に見える', () => {
    board('ended');
    const panel = screen.getByTestId('export-panel');
    expect(within(panel).getByTestId('export-csv')).toBeVisible();
    expect(within(panel).getByTestId('export-json')).toBeVisible();
    expect(within(panel).getByTestId('export-notice')).toBeVisible();
    expect(within(panel).getByTestId('export-columns')).toBeVisible();
  });

  it('進行中は出力のボタンを出さない', () => {
    board('running');
    expect(screen.queryByTestId('export-panel')).toBeNull();
  });
});

describe('BR23.10 表示名の入力欄の近くに、使えない先頭文字を示す', () => {
  it('参加の入力欄: 制限の説明が入力欄に関連づく', () => {
    render(
      <JoinScreen
        api={fakeApi()}
        onJoined={noop}
        onFacilitator={noop}
        onObserver={noop}
        onCreate={noop}
      />,
    );
    const input = screen.getByTestId('join-name');
    const rule = screen.getByTestId('join-name-rule');
    expect(rule).toHaveTextContent('先頭に = + - @ は使えません');
    expect(input.getAttribute('aria-describedby')).toContain(rule.id);
  });

  it('サーバーが 422 で拒否したら、その理由が表示名の欄に出る', async () => {
    const api = fakeApi({
      join: async () => {
        throw Object.assign(
          problem({
            kind: 'validation',
            reason: '参加の入力に誤りがあります',
            hint: '= + - @ 以外の文字で始まる名前にしてください',
            fields: [{ path: 'displayName', message: '表示名の先頭に使えない文字があります' }],
          }),
        );
      },
    });
    render(
      <JoinScreen
        api={api}
        onJoined={noop}
        onFacilitator={noop}
        onObserver={noop}
        onCreate={noop}
      />,
    );
    await userEvent.type(screen.getByTestId('join-code'), 'ABCD2345');
    await userEvent.type(screen.getByTestId('join-name'), '=cmd');
    await userEvent.click(screen.getByTestId('join-submit'));
    await waitFor(() =>
      expect(screen.getByText('表示名の先頭に使えない文字があります')).toBeInTheDocument(),
    );
  });

  it('担当者の入れ替えの入力欄にも、同じ制限を示す', async () => {
    render(
      <FacilitatorBoard
        api={fakeApi()}
        credential={facilitatorCredential}
        state={facilitatorState({
          assignees: [{ participantId: 'p1', label: '太郎 #1', role: 'retailer' }],
        })}
        refresh={noop}
      />,
    );
    await userEvent.click(screen.getByTestId('replace-open-p1'));
    const rule = screen.getByTestId('replace-name-rule');
    expect(rule).toHaveTextContent('先頭に = + - @ は使えません');
    expect(screen.getByTestId('replace-name').getAttribute('aria-describedby')).toContain(rule.id);
  });
});
