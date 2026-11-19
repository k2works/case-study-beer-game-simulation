import { describe, expect, it, vi } from 'vitest';
import { fetchCaughtUp } from './catchUp';
import type { StreamVersions } from './types';

const snap = (session: number | null, game: number | null = null) => ({
    versions: { game, session } satisfies StreamVersions,
});

describe('fetchCaughtUp（応答の versions に、取得したスナップショットが追いつくまで待つ）', () => {
    it('最初の取得が追いついていれば、1 回で返す', async () => {
        const load = vi.fn().mockResolvedValue(snap(5));
        const result = await fetchCaughtUp(
            load,
            { game: null, session: 5 },
            { attempts: 3, intervalMs: 0 },
        );
        expect(result.caughtUp).toBe(true);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('古ければ、追いつくまで再取得する', async () => {
        const load = vi
            .fn()
            .mockResolvedValueOnce(snap(4))
            .mockResolvedValueOnce(snap(4))
            .mockResolvedValueOnce(snap(6));
        const result = await fetchCaughtUp(
            load,
            { game: null, session: 5 },
            { attempts: 5, intervalMs: 0 },
        );
        expect(result.caughtUp).toBe(true);
        expect(result.snapshot.versions.session).toBe(6);
        expect(load).toHaveBeenCalledTimes(3);
    });

    it('上限まで追いつかなければ、caughtUp を false にして最後の取得を返す', async () => {
        const load = vi.fn().mockResolvedValue(snap(4));
        const result = await fetchCaughtUp(
            load,
            { game: null, session: 5 },
            { attempts: 3, intervalMs: 0 },
        );
        expect(result.caughtUp).toBe(false);
        expect(result.snapshot.versions.session).toBe(4);
        expect(load).toHaveBeenCalledTimes(3);
    });

    it('目標が null のストリームは比べない。値のあるストリームは、両方追いつく必要がある', async () => {
        const load = vi.fn().mockResolvedValueOnce(snap(10, 3)).mockResolvedValueOnce(snap(10, 4));
        const result = await fetchCaughtUp(
            load,
            { game: 4, session: 10 },
            { attempts: 3, intervalMs: 0 },
        );
        expect(result.caughtUp).toBe(true);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('取得の失敗は握りつぶさず、そのまま投げる', async () => {
        const load = vi.fn().mockRejectedValue(new Error('down'));
        await expect(
            fetchCaughtUp(load, { game: null, session: 5 }, { attempts: 3, intervalMs: 0 }),
        ).rejects.toThrow('down');
    });
});
