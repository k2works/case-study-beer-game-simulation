import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectNoStructuralA11yViolations } from '../../testing/a11y';
import { fakeApi } from '../../testing/fakeApi';
import { renderApp } from '../../testing/render';

describe('S11 ヘルプ（X-1）', () => {
    it('はじめる画面から「ヘルプ」へ進める', async () => {
        renderApp(fakeApi(), '/');

        await userEvent.click(screen.getByRole('link', { name: 'ヘルプ' }));

        expect(
            await screen.findByRole('heading', { level: 1, name: 'ヘルプ' }),
        ).toBeInTheDocument();
        expect(document.title).toBe('ヘルプ - ビールゲーム');
    });

    it('遊び方・1 週に起きること・役割・データの扱いの 4 節を、見出しで示す', () => {
        renderApp(fakeApi(), '/help');

        const headings = screen
            .getAllByRole('heading', { level: 2 })
            .map((heading) => heading.textContent);
        expect(headings).toEqual(['遊び方', '1 週に起きること', '4 つの役割', 'データの扱い']);
    });

    it('「1 週に起きること」は、業務ルールの順（入荷・受注・出荷・在庫と受注残・費用・発注の遅れ）を番号つきで示す', () => {
        renderApp(fakeApi(), '/help');

        const section = screen.getByRole('region', { name: '1 週に起きること' });
        const steps = within(section)
            .getAllByRole('listitem')
            .map((item) => item.textContent ?? '');
        expect(steps.length).toBeGreaterThanOrEqual(6);
        expect(steps[0]).toContain('入荷');
        expect(steps.some((step) => step.includes('出荷'))).toBe(true);
        expect(steps.some((step) => step.includes('費用'))).toBe(true);
        expect(steps.some((step) => step.includes('2 週'))).toBe(true);
    });

    it('ヘルプには、他の役割の値や資格を示さず、はじめる画面へ戻る導線がある', () => {
        renderApp(fakeApi(), '/help');

        expect(screen.getByRole('link', { name: 'はじめるへ戻る' })).toHaveAttribute('href', '/');
    });

    it('構造のアクセシビリティの検査に通る', () => {
        renderApp(fakeApi(), '/help');

        expectNoStructuralA11yViolations();
    });
});
