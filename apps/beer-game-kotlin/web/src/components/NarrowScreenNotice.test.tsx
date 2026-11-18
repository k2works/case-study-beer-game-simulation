import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NarrowScreenNotice } from './NarrowScreenNotice';

function stubMatchMedia(matches: boolean) {
    vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
            matches,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })),
    );
}

describe('狭い画面の案内（beer-game2 の UI 設計 差分 13）', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('幅が 1024px 未満のとき、パソコン（1024px 以上）での利用を想定していることを案内する', () => {
        stubMatchMedia(true);

        render(<NarrowScreenNotice />);

        const note = screen.getByRole('note', { name: '画面の大きさについて' });
        expect(note).toHaveTextContent('1024px 以上');
    });

    it('案内は閉じられる。閉じても操作は止まらない', async () => {
        stubMatchMedia(true);
        render(<NarrowScreenNotice />);

        await userEvent.click(screen.getByRole('button', { name: '案内を閉じる' }));

        expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });

    it('幅が 1024px 以上のときは、案内を出さない', () => {
        stubMatchMedia(false);

        render(<NarrowScreenNotice />);

        expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });

    it('画面の幅を調べられない環境（matchMedia が無い）でも、描画で落ちず、案内は出さない', () => {
        vi.stubGlobal('matchMedia', undefined);

        render(<NarrowScreenNotice />);

        expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });
});
