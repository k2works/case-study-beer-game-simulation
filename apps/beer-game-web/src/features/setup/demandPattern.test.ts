import { describe, expect, it } from 'vitest';
import { buildDemand } from './demandPattern';

describe('需要系列の作成（一定・増加・減少）', () => {
    it('一定: 開始値を最終週まで並べる（増分値は使わない）', () => {
        expect(buildDemand('CONSTANT', 4, 9, 5)).toEqual([4, 4, 4, 4, 4]);
    });

    it('増加: 1 週目を開始値とし、週ごとに増分値ずつ増やして最終週まで作る', () => {
        expect(buildDemand('INCREASE', 4, 2, 5)).toEqual([4, 6, 8, 10, 12]);
    });

    it('減少: 週ごとに増分値ずつ減らす。0 を下回らず、0 で止まる', () => {
        expect(buildDemand('DECREASE', 7, 3, 5)).toEqual([7, 4, 1, 0, 0]);
    });

    it('増加は 1000 を超えず、1000 で止まる', () => {
        expect(buildDemand('INCREASE', 990, 6, 4)).toEqual([990, 996, 1000, 1000]);
    });

    it('増分値 0 なら、増加も減少も一定と同じになる', () => {
        expect(buildDemand('INCREASE', 4, 0, 3)).toEqual([4, 4, 4]);
        expect(buildDemand('DECREASE', 4, 0, 3)).toEqual([4, 4, 4]);
    });
});
