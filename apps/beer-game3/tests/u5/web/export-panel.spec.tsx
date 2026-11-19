// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportPanel } from '../../../src/web/screens/ExportPanel.js';
import { facilitatorCredential, fakeApi, problem } from '../../u1/web/support.js';

afterEach(cleanup);

const file = (name: string) => ({ blob: new Blob(['x']), filename: name });

describe('US4.2 BR23.9 出力ボタンの近くに、注意と列名の説明を日本語で常に示す', () => {
  it('ボタン、注意、列名の表、役割の対応が同時に表示される（折りたたまない）', () => {
    render(<ExportPanel api={fakeApi()} credential={facilitatorCredential} />);
    const panel = screen.getByTestId('export-panel');
    expect(within(panel).getByTestId('export-csv')).toHaveTextContent('CSV で出力');
    expect(within(panel).getByTestId('export-json')).toHaveTextContent('JSON で出力');
    expect(within(panel).getByTestId('export-notice')).toHaveTextContent(
      '表計算ソフトで CSV を開くとき、表示名が式として実行されないよう注意してください',
    );
    expect(within(panel).getByTestId('export-notice')).toHaveTextContent(
      '信頼できない表示名があるときは、テキストとして読み込んでください',
    );
    expect(panel.querySelector('details')).toBeNull();

    const columns = within(panel).getByTestId('export-columns');
    for (const name of [
      'gameId',
      'setupKind',
      'week',
      'role',
      'customerDemand',
      'receipt',
      'ordersReceived',
      'shipped',
      'inventory',
      'backlog',
      'decision',
      'weeklyCostCents',
      'cumulativeCostCents',
      'decidedByKind',
      'decidedByDisplayName',
    ]) {
      expect(within(columns).getByText(name), name).toBeInTheDocument();
    }
    expect(columns).toHaveTextContent('セント');
    expect(columns).toHaveTextContent('発注');
    const roles = within(panel).getByTestId('export-roles');
    expect(roles).toHaveTextContent('factory');
    expect(roles).toHaveTextContent('工場');
    expect(roles).toHaveTextContent('wholesaler1');
    expect(roles).toHaveTextContent('卸売店 1');
    expect(roles).toHaveTextContent('wholesaler2');
    expect(roles).toHaveTextContent('卸売店 2');
    expect(roles).toHaveTextContent('retailer');
    expect(roles).toHaveTextContent('小売店');
  });

  it('列名と役割の値は、読み戻すための識別子として英語のままで、説明は日本語', () => {
    render(<ExportPanel api={fakeApi()} credential={facilitatorCredential} />);
    const rows = within(screen.getByTestId('export-columns')).getAllByRole('row');
    expect(rows.length).toBe(1 + 15);
    const week = rows.find((row) => within(row).queryByText('week'))!;
    expect(week).toHaveTextContent(/週/);
  });
});

describe('US4.2 ボタンの操作: ヘッダ付きの取得 → ダウンロード', () => {
  it('CSV で出力を押すと、API を csv で呼び、返ったファイルを保存する', async () => {
    const download = vi.fn();
    const api = fakeApi({ exportGame: async () => file('beer-game-g1.csv') });
    render(<ExportPanel api={api} credential={facilitatorCredential} download={download} />);
    await userEvent.click(screen.getByTestId('export-csv'));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(api.exportGame).toHaveBeenCalledWith(facilitatorCredential, 'csv');
    expect(download.mock.calls[0]![1]).toBe('beer-game-g1.csv');
    expect(await screen.findByTestId('export-done')).toHaveTextContent('beer-game-g1.csv');
  });

  it('JSON で出力を押すと、json で呼ぶ。取得の間はボタンを押せない', async () => {
    let release: () => void = () => undefined;
    const api = fakeApi({
      exportGame: () =>
        new Promise((resolve) => {
          release = () => resolve(file('beer-game-g1.json'));
        }),
    });
    const download = vi.fn();
    render(<ExportPanel api={api} credential={facilitatorCredential} download={download} />);
    await userEvent.click(screen.getByTestId('export-json'));
    expect(api.exportGame).toHaveBeenCalledWith(facilitatorCredential, 'json');
    expect(screen.getByTestId('export-csv')).toBeDisabled();
    expect(screen.getByTestId('export-json')).toBeDisabled();
    release();
    await waitFor(() => expect(download).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('export-csv')).toBeEnabled());
  });

  it('失敗したら、理由と直し方を示し、ファイルは保存しない', async () => {
    const download = vi.fn();
    const api = fakeApi({
      exportGame: async () => {
        throw problem({
          kind: 'state',
          reason: 'ゲームが終了していないため出力できません',
          hint: 'ゲームを終了してから出力してください',
        });
      },
    });
    render(<ExportPanel api={api} credential={facilitatorCredential} download={download} />);
    await userEvent.click(screen.getByTestId('export-csv'));
    const error = await screen.findByTestId('export-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent('ゲームを終了してから出力してください');
    expect(download).not.toHaveBeenCalled();
  });
});
