// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PlayScreen } from '../../../src/web/screens/PlayScreen.js';
import type { GameStateView } from '../../../src/web/api.js';
import { fakeApi, participantCredential, participantState } from '../../u1/web/support.js';

afterEach(cleanup);

const withMine = (
  mine: Partial<NonNullable<GameStateView['mine']>>,
  overrides: Partial<GameStateView> = {},
): GameStateView => {
  const base = participantState(overrides);
  return { ...base, mine: { ...base.mine!, ...mine } };
};

function mount(state: GameStateView) {
  const api = fakeApi();
  const view = render(
    <PlayScreen
      api={api}
      credential={participantCredential}
      state={state}
      refresh={() => undefined}
    />,
  );
  const update = (next: GameStateView) =>
    view.rerender(
      <PlayScreen
        api={api}
        credential={participantCredential}
        state={next}
        refresh={() => undefined}
      />,
    );
  return { api, update };
}

describe('S3 役割別プレイ — 一時停止中の表示（AC2.5.1）', () => {
  it('一時停止中は「一時停止中」を示し、入力を保存できないが、状況は見える', () => {
    mount(withMine({ decision: 7, decisionRevision: 1 }, { status: 'paused' }));
    expect(screen.getByTestId('paused-notice')).toHaveTextContent('一時停止中');
    expect(screen.getByTestId('decision-submit')).toBeDisabled();
    expect(screen.getByTestId('decision-input')).toBeDisabled();
    expect(screen.getByTestId('status-panel')).toBeInTheDocument();
  });

  it('進行中は一時停止中の表示を出さない', () => {
    mount(withMine({}, { status: 'running' }));
    expect(screen.queryByTestId('paused-notice')).toBeNull();
    expect(screen.getByTestId('decision-submit')).toBeEnabled();
  });
});

describe('S3 役割別プレイ — 共同担当の置き換わりの表示（AC2.2.1、BR12.2）', () => {
  const other = { kind: 'participant' as const, label: '次郎 #5', participantId: 'p9' };

  it('最初に受け取った版では、入力者が自分でなくても通知を出さない（再読み込み・入れ替え直後）', () => {
    mount(withMine({ decision: 10, decisionRevision: 4, decidedBy: other }));
    expect(screen.queryByTestId('replaced-notice')).toBeNull();
  });

  it('版が増え、入力者が別の人のとき「<ラベル> が <値> に変更しました」を示す', () => {
    const { update } = mount(
      withMine({
        decision: 8,
        decisionRevision: 1,
        decidedBy: { kind: 'participant', label: '太郎 #1', participantId: 'p1' },
      }),
    );
    update(withMine({ decision: 10, decisionRevision: 2, decidedBy: other }));
    expect(screen.getByTestId('replaced-notice')).toHaveTextContent('次郎 #5 が 10 に変更しました');
  });

  it('版が増えても、入力者が自分なら通知を出さない', () => {
    const me = { kind: 'participant' as const, label: '太郎 #1', participantId: 'p1' };
    const { update } = mount(withMine({ decision: 8, decisionRevision: 1, decidedBy: me }));
    update(withMine({ decision: 9, decisionRevision: 2, decidedBy: me }));
    expect(screen.queryByTestId('replaced-notice')).toBeNull();
  });

  it('進行役の代理入力で置き換わったときは「進行役」を示す', () => {
    const me = { kind: 'participant' as const, label: '太郎 #1', participantId: 'p1' };
    const { update } = mount(withMine({ decision: 8, decisionRevision: 1, decidedBy: me }));
    update(
      withMine({
        decision: 5,
        decisionRevision: 2,
        decidedBy: { kind: 'facilitator', label: '進行役' },
      }),
    );
    expect(screen.getByTestId('replaced-notice')).toHaveTextContent('進行役 が 5 に変更しました');
  });

  it('週が変わったら通知を消し、新しい週の最初の版を基準にする', () => {
    const me = { kind: 'participant' as const, label: '太郎 #1', participantId: 'p1' };
    const { update } = mount(withMine({ decision: 8, decisionRevision: 1, decidedBy: me }));
    update(withMine({ decision: 10, decisionRevision: 2, decidedBy: other }));
    expect(screen.getByTestId('replaced-notice')).toBeInTheDocument();
    update(
      withMine(
        { week: 2, decision: null, decisionRevision: 0, decidedBy: null },
        { currentWeek: 2 },
      ),
    );
    expect(screen.queryByTestId('replaced-notice')).toBeNull();
  });
});
