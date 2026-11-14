// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLES } from '../../../src/server/domain/types.js';
import type { ResultsView } from '../../../src/web/api.js';
import { formatCents } from '../../../src/web/format.js';
import { SERIES_STYLES } from '../../../src/web/chart.js';
import { ResultsScreen } from '../../../src/web/screens/ResultsScreen.js';
import {
  facilitatorCredential,
  fakeApi,
  participantCredential,
  problem,
} from '../../u1/web/support.js';
import { contrastRatio, makeView, roleValues } from './support.js';

afterEach(cleanup);

function renderResults(
  view: ResultsView | Error,
  options: { facilitator?: boolean; onBack?: () => void } = {},
) {
  const api = fakeApi({
    getResults: async () => {
      if (view instanceof Error) {
        throw view;
      }
      return view;
    },
  });
  render(
    <ResultsScreen
      api={api}
      credential={options.facilitator ? facilitatorCredential : participantCredential}
      gameName="授業"
      onBack={options.onBack ?? (() => undefined)}
    />,
  );
  return api;
}

const lineOf = (role: string) => screen.getByTestId(`line-${role}`);
const valuesOf = (role: string): number[] =>
  lineOf(role).getAttribute('data-values')!.split(',').map(Number);

describe('US4.1 AC4.1.1 結果画面に全役割の需要、注文、在庫、受注残、出荷、費用の時系列が見える', () => {
  it('開くと、見出し、ゲーム名、種別、確定済みの週の数、初期の指標（費用の累積）の 4 系列とチームの合計が出る', async () => {
    const view = makeView(3);
    const api = renderResults(view);
    expect(await screen.findByTestId('results-screen')).toBeInTheDocument();
    expect(api.getResults).toHaveBeenCalledWith(participantCredential);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('結果');
    expect(screen.getByTestId('results-summary')).toHaveTextContent('授業');
    expect(screen.getByTestId('results-summary')).toHaveTextContent('カスタム');
    expect(screen.getByTestId('results-summary')).toHaveTextContent('確定済みの週: 3');
    expect(screen.getByTestId('metric-cost')).toBeChecked();
    expect(screen.getByTestId('cost-mode-cumulative')).toBeChecked();
    for (const role of ROLES) {
      expect(valuesOf(role)).toEqual(roleValues(view, role, (w) => w.cumulativeCost));
    }
    expect(screen.getByTestId('team-total')).toHaveTextContent(
      formatCents(view.teamCumulativeCost),
    );
  });

  it('6 つの指標を選べて、選ぶと同じ週の軸で 4 役割の系列に切り替わる（表も同じ数値）', async () => {
    const view = makeView(4);
    renderResults(view);
    await screen.findByTestId('results-screen');
    const picks = {
      demand: (w: ResultsView['roles'][0]['weeks'][0]) => w.ordersReceived,
      order: (w: ResultsView['roles'][0]['weeks'][0]) => w.decision,
      inventory: (w: ResultsView['roles'][0]['weeks'][0]) => w.inventory,
      backlog: (w: ResultsView['roles'][0]['weeks'][0]) => w.backlog,
      shipped: (w: ResultsView['roles'][0]['weeks'][0]) => w.shipped,
    };
    for (const [id, pick] of Object.entries(picks)) {
      await userEvent.click(screen.getByTestId(`metric-${id}`));
      expect(screen.getByTestId(`metric-${id}`)).toBeChecked();
      for (const role of ROLES) {
        expect(valuesOf(role), `${id} / ${role}`).toEqual(roleValues(view, role, pick));
      }
      // 表は、グラフと同じ数値（行が週、列が 4 役割）
      const table = screen.getByTestId('results-table');
      const rows = within(table).getAllByRole('row');
      expect(rows).toHaveLength(1 + 4);
      ROLES.forEach((role, column) => {
        const cells = rows
          .slice(1)
          .map((row) => within(row).getAllByRole('cell')[column]!.textContent);
        expect(cells).toEqual(roleValues(view, role, pick).map(String));
      });
    }
  });

  it('AC4.1.2 「受注残」を選ぶと、4 役割の受注残が同じ週の軸で重なって表示される', async () => {
    const view = makeView(3);
    renderResults(view);
    await screen.findByTestId('results-screen');
    await userEvent.click(screen.getByTestId('metric-backlog'));
    const chart = screen.getByTestId('results-chart');
    for (const role of ROLES) {
      expect(within(chart).getByTestId(`series-${role}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('results-table')).toHaveTextContent('受注残');
    // 同じ軸: すべての系列の点の数が週の数と同じ
    for (const role of ROLES) {
      expect(valuesOf(role)).toHaveLength(3);
    }
    expect(chart.querySelectorAll('[data-axis="week"]').length).toBeGreaterThan(0);
  });

  it('BR22.3 費用は週ごと・累積を切り替えられ、金額は通貨の形（整数のセントを $ と小数 2 桁）で表に出る', async () => {
    const view = makeView(3);
    renderResults(view);
    await screen.findByTestId('results-screen');
    await userEvent.click(screen.getByTestId('cost-mode-weekly'));
    for (const role of ROLES) {
      expect(valuesOf(role)).toEqual(roleValues(view, role, (w) => w.weeklyCost));
    }
    const table = screen.getByTestId('results-table');
    const first = view.roles[0]!.weeks[0]!.weeklyCost;
    expect(within(table).getAllByRole('cell')[0]).toHaveTextContent(formatCents(first));
    // 費用以外の指標では、切り替えは出ない
    await userEvent.click(screen.getByTestId('metric-inventory'));
    expect(screen.queryByTestId('cost-mode-weekly')).toBeNull();
  });

  it('金額の整形は整数だけで行い、端数の誤差が出ない', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(12345)).toBe('$123.45');
    expect(formatCents(9007199254740991)).toBe('$90071992547409.91');
    const view = makeView(3);
    const total = view.roles.reduce((sum, r) => sum + r.weeks.at(-1)!.cumulativeCost, 0);
    expect(view.teamCumulativeCost).toBe(total);
  });
});

describe('US4.1 AC4.1.3 色を区別できない人も、線種・印・凡例で系列を区別できる', () => {
  it('役割ごとに、線種も印も異なる。凡例は同じ線種・印・役割名を示す', async () => {
    renderResults(makeView(3));
    await screen.findByTestId('results-screen');
    const dashes = ROLES.map((role) => lineOf(role).getAttribute('stroke-dasharray'));
    expect(new Set(dashes).size).toBe(4);
    const markers = ROLES.map((role) =>
      screen
        .getByTestId(`series-${role}`)
        .querySelector('[data-marker]')!
        .getAttribute('data-marker'),
    );
    expect(new Set(markers).size).toBe(4);
    const legend = screen.getByTestId('legend');
    const labels = ['工場', '一次卸', '二次卸', '小売店'];
    ROLES.forEach((role, i) => {
      const item = within(legend).getByTestId(`legend-${role}`);
      expect(item).toHaveTextContent(labels[i]!);
      expect(item.querySelector('[data-dash]')!.getAttribute('data-dash')).toBe(dashes[i]);
      expect(item.querySelector('[data-marker]')!.getAttribute('data-marker')).toBe(markers[i]);
    });
  });

  it('どの指標でも、役割の並びと系列の記号は同じ', async () => {
    renderResults(makeView(3));
    await screen.findByTestId('results-screen');
    const before = ROLES.map((role) => lineOf(role).getAttribute('stroke-dasharray'));
    await userEvent.click(screen.getByTestId('metric-backlog'));
    expect(ROLES.map((role) => lineOf(role).getAttribute('stroke-dasharray'))).toEqual(before);
    expect(within(screen.getByTestId('legend')).getAllByRole('listitem')).toHaveLength(4);
  });

  it('NFR8.1 線の色は白い背景に 3:1 以上、4 色とも異なる', () => {
    const colors = ROLES.map((role) => SERIES_STYLES[role].color);
    expect(new Set(colors).size).toBe(4);
    for (const color of colors) {
      expect(contrastRatio(color, '#ffffff'), color).toBeGreaterThanOrEqual(3);
    }
  });

  it('グラフは role="img" と説明を持ち、同じ数値の表（caption と見出しつき）を併記する', async () => {
    renderResults(makeView(3));
    await screen.findByTestId('results-screen');
    const chart = screen.getByTestId('results-chart');
    expect(chart).toHaveAttribute('role', 'img');
    expect(chart.getAttribute('aria-label')).toMatch(/累積費用/);
    const table = screen.getByTestId('results-table');
    expect(table.querySelector('caption')!.textContent).toMatch(/累積費用/);
    expect(table.querySelectorAll('th[scope="col"]')).toHaveLength(1 + 4);
    expect(table.querySelectorAll('th[scope="row"]')).toHaveLength(3);
  });
});

describe('NFR8.1 キーボードだけで、指標と費用の切り替えを操作できる', () => {
  it('指標のラジオは 1 つのグループで、矢印キーで次の指標に移れる。フォーカスの印は消さない', async () => {
    renderResults(makeView(3));
    await screen.findByTestId('results-screen');
    const group = screen.getByRole('radiogroup', { name: '指標' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(6);
    expect(new Set(radios.map((r) => r.getAttribute('name'))).size).toBe(1);

    screen.getByTestId('metric-cost').focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByTestId('metric-shipped')).toBeChecked();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByTestId('metric-cost')).toBeChecked();
  });

  it('選択中の状態を色以外でも示す（チェックの状態と、選択中のラベルの目印）', async () => {
    renderResults(makeView(3));
    await screen.findByTestId('results-screen');
    expect(screen.getByTestId('metric-label-cost')).toHaveAttribute('data-selected', 'true');
    await userEvent.click(screen.getByTestId('metric-demand'));
    expect(screen.getByTestId('metric-label-demand')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('metric-label-cost')).toHaveAttribute('data-selected', 'false');
  });
});

describe('BR21.1 終了前の URL 直接アクセスや、取得できない場合の表示', () => {
  it('終了前（403）は、拒否の理由と直し方を示し、グラフを出さない', async () => {
    renderResults(
      problem({
        kind: 'forbidden',
        reason: 'ゲームが終了するまで、結果は見られません',
        hint: 'ゲームが終了してから、もう一度開いてください',
      }),
    );
    const alert = await screen.findByTestId('results-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('ゲームが終了するまで、結果は見られません');
    expect(alert).toHaveTextContent('ゲームが終了してから、もう一度開いてください');
    expect(screen.queryByTestId('results-chart')).toBeNull();
  });

  it('通信できなかったときも、グラフを出さずに理由を示す', async () => {
    renderResults(new Error('network'));
    expect(await screen.findByTestId('results-error')).toHaveTextContent(
      'もう一度操作してください',
    );
  });

  it('確定済みの週がないときは、グラフでなく説明を出す', async () => {
    renderResults(makeView(0, { confirmedWeeks: 0, teamCumulativeCost: 0 }));
    expect(await screen.findByTestId('results-empty')).toHaveTextContent('確定した週がありません');
    expect(screen.queryByTestId('results-chart')).toBeNull();
  });

  it('戻る導線がある', async () => {
    const onBack = vi.fn();
    renderResults(makeView(3), { onBack });
    await userEvent.click(await screen.findByTestId('results-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('NFR8.2 50 週のゲーム（200 点）の描画', () => {
  it('グラフと表を合わせて描画し、時間を記録する。印は 5 週ごとに間引き、線は全点を結ぶ', async ({
    annotate,
  }) => {
    const view = makeView(50);
    const started = performance.now();
    renderResults(view);
    await screen.findByTestId('results-screen');
    const elapsed = Math.round(performance.now() - started);
    await annotate(`50 週の結果画面の描画: ${elapsed} ms（jsdom）`);
    expect(elapsed).toBeLessThan(1000);
    for (const role of ROLES) {
      expect(valuesOf(role)).toHaveLength(50);
      const markers = screen.getByTestId(`series-${role}`).querySelectorAll('[data-marker]');
      expect(markers.length).toBeLessThanOrEqual(12);
      expect(markers.length).toBeGreaterThan(0);
    }
    expect(within(screen.getByTestId('results-table')).getAllByRole('row')).toHaveLength(51);
  });
});

describe('出力のパネルは進行役にだけ出る', () => {
  it('進行役の資格情報なら出力のボタンがあり、参加者にはない', async () => {
    renderResults(makeView(3), { facilitator: true });
    await screen.findByTestId('results-screen');
    await waitFor(() => expect(screen.getByTestId('export-csv')).toBeInTheDocument());
    cleanup();
    renderResults(makeView(3));
    await screen.findByTestId('results-screen');
    expect(screen.queryByTestId('export-csv')).toBeNull();
  });
});
