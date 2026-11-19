import { describe, expect, it } from 'vitest';
import {
  extractLandmarks,
  extractSteps,
  groupTours,
  isUpToDate,
  renderMap,
  renderTour,
  validateLandmarks,
  type Landmark,
  type TourStep,
} from '../../scripts/lib/guided-tour.js';

const sample = `
import x from 'y';

/**
 * 使い方の説明（これはツアーとは別の、通常のコメント）。
 * @guidedTour demo 20 ユースケースが、集約を呼んで保存する。
 *   ルールは持たない。
 */
export function createApplication() {}

/** 普通のコメント。タグは無い */
export function other() {}

/**
 * @guidedTour demo 10 入口。
 */
export class PlayScreen {}

/**
 * @guidedTour demo 100 最後のステップ。
 */
test('[US2.3] 縦に通る', async () => {});
`;

describe('extractSteps', () => {
  const steps = extractSteps(sample, 'src/app.ts');

  it('[ガイドツアー] タグ付きの宣言だけを、ツアー名・順序・説明つきで取り出す', () => {
    expect(steps.map((s) => [s.tour, s.rank, s.symbol])).toEqual([
      ['demo', 20, 'createApplication'],
      ['demo', 10, 'PlayScreen'],
      ['demo', 100, '[US2.3] 縦に通る'],
    ]);
    expect(steps[0]?.file).toBe('src/app.ts');
  });

  it('[ガイドツアー] 説明は、次のタグまでの続きの行をつなげる', () => {
    expect(steps[0]?.description).toBe(
      'ユースケースが、集約を呼んで保存する。 ルールは持たない。',
    );
  });

  it('[ガイドツアー] 宣言の種類（function、class、const、interface、test）に対応する', () => {
    const kinds = `
/** @guidedTour t 10 a */
export const buildServer = () => {};
/** @guidedTour t 20 b */
export interface Lobby {}
/** @guidedTour t 30 c */
export async function review() {}
/** @guidedTour t 40 d */
class PgUnitOfWork {}
`;
    expect(extractSteps(kinds, 'f.ts').map((s) => s.symbol)).toEqual([
      'buildServer',
      'Lobby',
      'review',
      'PgUnitOfWork',
    ]);
  });

  it('[ガイドツアー] 宣言が見つからないタグは、エラーにする（黙って捨てない）', () => {
    expect(() =>
      extractSteps('/** @guidedTour t 10 説明 */\n\n', 'f.ts'),
    ).toThrow(/f\.ts/);
  });

  it('[ガイドツアー] 順序が数値でないタグは、エラーにする', () => {
    expect(() =>
      extractSteps(
        '/** @guidedTour t abc 説明 */\nexport function f() {}',
        'f.ts',
      ),
    ).toThrow(/順序/);
  });
});

describe('groupTours', () => {
  const step = (tour: string, rank: number, symbol = `s${rank}`): TourStep => ({
    tour,
    rank,
    symbol,
    description: `${symbol} の説明`,
    file: `src/${symbol}.ts`,
  });

  it('[ガイドツアー] ツアーごとに、順序の数値で並べる（100 は 20 の後）', () => {
    const tours = groupTours([
      step('a', 100),
      step('a', 20),
      step('a', 3),
      step('b', 1),
    ]);
    expect([...tours.keys()]).toEqual(['a', 'b']);
    expect(tours.get('a')?.map((s) => s.rank)).toEqual([3, 20, 100]);
  });

  it('[ガイドツアー] 同じツアーで順序が重複したら、エラーにする', () => {
    expect(() => groupTours([step('a', 10, 'x'), step('a', 10, 'y')])).toThrow(
      /重複/,
    );
  });
});

describe('renderTour', () => {
  const steps: TourStep[] = [
    {
      tour: 't',
      rank: 10,
      symbol: 'PlayScreen',
      description: '入口。',
      file: 'ui/src/play.tsx',
    },
    {
      tour: 't',
      rank: 20,
      symbol: 'buildServer',
      description: '次はここ。',
      file: 'src/server.ts',
    },
  ];
  const md = renderTour(
    steps,
    { title: 'テストのツアー', intro: '導入の文。' },
    'https://example.test/blob/develop/apps/x',
  );

  it('[ガイドツアー] 見出し・導入・ステップを、順に出力する', () => {
    expect(md).toContain('# テストのツアー');
    expect(md).toContain('導入の文。');
    expect(md.indexOf('PlayScreen')).toBeLessThan(md.indexOf('buildServer'));
    expect(md).toMatch(/## 1\. PlayScreen/);
    expect(md).toMatch(/## 2\. buildServer/);
    expect(md).toContain('入口。');
  });

  it('[ガイドツアー] 各ステップから、該当ファイルへのリンクを張る（行番号は含めない）', () => {
    expect(md).toContain(
      '[`ui/src/play.tsx`](https://example.test/blob/develop/apps/x/ui/src/play.tsx)',
    );
    expect(md).not.toMatch(/#L\d+/);
  });

  it('[ガイドツアー] 同じ入力なら、同じ出力になる（決定論）', () => {
    expect(
      renderTour(
        steps,
        { title: 'テストのツアー', intro: '導入の文。' },
        'https://example.test/blob/develop/apps/x',
      ),
    ).toBe(md);
  });
});

describe('isUpToDate', () => {
  it('[ガイドツアー] 生成日時（at）だけが違うときは、最新として扱う', () => {
    const a =
      '---\ngenerated: { by: script, at: 2026-11-10T00:00:00Z }\n---\n本文\n';
    const b =
      '---\ngenerated: { by: script, at: 2026-12-01T09:00:00Z }\n---\n本文\n';
    expect(isUpToDate(a, b)).toBe(true);
  });

  it('[ガイドツアー] 本文が違えば、古い', () => {
    const a =
      '---\ngenerated: { by: script, at: 2026-11-10T00:00:00Z }\n---\n本文 A\n';
    const b =
      '---\ngenerated: { by: script, at: 2026-11-10T00:00:00Z }\n---\n本文 B\n';
    expect(isUpToDate(a, b)).toBe(false);
  });
});

describe('サイトシーイング・マップ（@landmark）', () => {
  const source = `
/**
 * 通常の説明。
 * @landmark 週次の計算。ここを理解すれば、ゲームのルールが分かる。
 *   時刻・DB に依存しない。
 */
export function simulateWeek() {}

/** タグの無い宣言 */
export function other() {}

/**
 * @guidedTour demo 10 ツアーのステップ（見どころではない）
 */
export class OnlyTour {}

/**
 * @guidedTour demo 20 ツアーと見どころの両方
 * @landmark 見どころでもある。
 */
export interface Session {}
`;

  it('[ガイドツアー] @landmark の付いた宣言だけを、説明つきで取り出す（ツアーのタグとは独立）', () => {
    const marks = extractLandmarks(source, 'src/x.ts');
    expect(marks.map((m) => m.symbol)).toEqual(['simulateWeek', 'Session']);
    expect(marks[0]?.description).toBe(
      '週次の計算。ここを理解すれば、ゲームのルールが分かる。 時刻・DB に依存しない。',
    );
    expect(marks[1]?.description).toBe('見どころでもある。');
  });

  it('[ガイドツアー] 1 つの宣言に、ツアーと見どころの両方を付けても、互いの説明に混ざらない', () => {
    const steps = extractSteps(source, 'src/x.ts');
    expect(steps.map((s) => s.symbol)).toEqual(['OnlyTour', 'Session']);
    expect(steps[1]?.description).toBe('ツアーと見どころの両方');
  });

  it('[ガイドツアー] 宣言が見つからない @landmark は、エラーにする', () => {
    expect(() => extractLandmarks('/** @landmark 説明 */\n\n', 'f.ts')).toThrow(
      /f\.ts/,
    );
  });

  const mark = (n: number): Landmark => ({
    symbol: `S${n}`,
    description: `説明 ${n}`,
    file: `src/s${n}.ts`,
  });

  it('[ガイドツアー] 見どころは 1〜10 個。多すぎるとエラー（5〜7 個に絞る）', () => {
    expect(() => validateLandmarks([])).toThrow(/1/);
    expect(() =>
      validateLandmarks(Array.from({ length: 10 }, (_, i) => mark(i))),
    ).not.toThrow();
    expect(() =>
      validateLandmarks(Array.from({ length: 11 }, (_, i) => mark(i))),
    ).toThrow(/10/);
  });

  it('[ガイドツアー] 表で出力し、場所へのリンクを張る（行番号なし）。同じ入力なら同じ出力', () => {
    const md = renderMap(
      [mark(1), mark(2)],
      { title: '地図', intro: '導入。' },
      'https://e.test/b',
    );
    expect(md).toContain('# 地図');
    expect(md).toContain('| 見どころ | 場所 | 理由 |');
    expect(md).toContain(
      '| `S1` | [`src/s1.ts`](https://e.test/b/src/s1.ts) | 説明 1 |',
    );
    expect(md).not.toMatch(/#L\d+/);
    expect(
      renderMap(
        [mark(1), mark(2)],
        { title: '地図', intro: '導入。' },
        'https://e.test/b',
      ),
    ).toBe(md);
  });

  it('[ガイドツアー] 説明の中の「|」は、表を壊さないようにエスケープする', () => {
    const md = renderMap(
      [{ symbol: 'A', description: 'a | b', file: 'src/a.ts' }],
      { title: 't', intro: 'i' },
      'https://e.test/b',
    );
    expect(md).toContain('a \\| b');
  });
});
