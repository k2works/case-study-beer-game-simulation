/**
 * ガイドツアーの生成（Living Documentation）。
 * コードの JSDoc に付けた `@guidedTour <ツアー名> <順序> <説明>` を集め、順序どおりの Markdown にする。
 * 順序は 10 刻みで付ける（途中に足せるように）。説明は、次のタグまでの続きの行をつなげる。
 */

export interface TourStep {
  tour: string;
  rank: number;
  /** 宣言の名前（関数・クラスなど）。テストは題名 */
  symbol: string;
  description: string;
  /** apps/beer-game2 からの相対パス */
  file: string;
}

export interface TourMeta {
  title: string;
  intro: string;
}

const COMMENT = /\/\*\*([\s\S]*?)\*\//g;
const DECLARATION: RegExp[] = [
  /^export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/,
  /^(?:async\s+)?function\s+([A-Za-z0-9_]+)/,
  /^export\s+(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/,
  /^(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/,
  /^export\s+(?:const|let)\s+([A-Za-z0-9_]+)/,
  /^export\s+(?:interface|type)\s+([A-Za-z0-9_]+)/,
  /^(?:test|it|describe)\(\s*['"`]([^'"`]+)['"`]/,
];

function declarationAfter(source: string, index: number): string | null {
  const rest = source.slice(index).split('\n');
  const next = rest.map((l) => l.trim()).find((l) => l.length > 0);
  if (!next) return null;
  for (const pattern of DECLARATION) {
    const m = pattern.exec(next);
    if (m) return m[1]!;
  }
  return null;
}

interface Tagged {
  /** タグの行（`@guidedTour` や `@landmark` を除いた残り） */
  head: string;
  /** 次の `@` タグまでの続きの行 */
  rest: string[];
  /** 直後の宣言の名前 */
  symbol: string | null;
}

/** JSDoc から、指定したタグ（例: `@guidedTour`）の付いたものを集める（出現順） */
function findTagged(source: string, tag: string): Tagged[] {
  const out: Tagged[] = [];
  for (const match of source.matchAll(COMMENT)) {
    const lines = match[1]!
      .split('\n')
      .map((l) => l.replace(/^\s*\*?\s?/, '').trim());
    const at = lines.findIndex((l) => l === tag || l.startsWith(`${tag} `));
    if (at < 0) continue;
    out.push({
      head: lines[at]!.slice(tag.length).trim(),
      rest: takeContinuation(lines.slice(at + 1)),
      symbol: declarationAfter(source, match.index! + match[0].length),
    });
  }
  return out;
}

const joinDescription = (head: string, rest: string[]) =>
  [head, ...rest].filter((l) => l.length > 0).join(' ');

/** ソースから、`@guidedTour` の付いた宣言を取り出す（出現順） */
export function extractSteps(source: string, file: string): TourStep[] {
  return findTagged(source, '@guidedTour').map((t) => {
    const tag = /^(\S+)\s+(\S+)\s*(.*)$/.exec(t.head);
    if (!tag)
      throw new Error(`${file}: @guidedTour の書式が不正です: ${t.head}`);
    const [, tour, rankText, first] = tag as unknown as [
      string,
      string,
      string,
      string,
    ];
    if (!/^\d+$/.test(rankText)) {
      throw new Error(`${file}: @guidedTour の順序は数値です（${rankText}）`);
    }
    if (!t.symbol) {
      throw new Error(
        `${file}: @guidedTour（${tour} ${rankText}）の直後に宣言が見つかりません`,
      );
    }
    return {
      tour,
      rank: Number(rankText),
      symbol: t.symbol,
      description: joinDescription(first, t.rest),
      file,
    };
  });
}

function takeContinuation(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (l.startsWith('@')) break;
    out.push(l);
  }
  return out;
}

/** ツアーごとにまとめ、順序（数値）で並べる。同じツアーの順序の重複は不正 */
export function groupTours(steps: TourStep[]): Map<string, TourStep[]> {
  const tours = new Map<string, TourStep[]>();
  for (const step of steps) {
    const list = tours.get(step.tour) ?? [];
    list.push(step);
    tours.set(step.tour, list);
  }
  for (const [name, list] of tours) {
    list.sort((a, b) => a.rank - b.rank);
    list.forEach((s, i) => {
      if (i > 0 && list[i - 1]!.rank === s.rank) {
        throw new Error(
          `ツアー ${name} の順序が重複しています: ${s.rank}（${list[i - 1]!.symbol} と ${s.symbol}）`,
        );
      }
    });
  }
  return tours;
}

/** 1 本のツアーを Markdown の本文にする。リンクは、行番号を含めない（行が動いても壊れない） */
export function renderTour(
  steps: TourStep[],
  meta: TourMeta,
  repoBase: string,
): string {
  const out: string[] = [`# ${meta.title}`, '', meta.intro, ''];
  steps.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.symbol}`, '');
    out.push(`[\`${s.file}\`](${repoBase}/${s.file})`, '');
    out.push(s.description, '');
  });
  return out.join('\n');
}

export interface Landmark {
  symbol: string;
  description: string;
  file: string;
}

/** 見どころは少数に絞る（5〜7 個が目安。多くても 10 個） */
export const MAX_LANDMARKS = 10;

/** ソースから、`@landmark <説明>` の付いた宣言を取り出す（出現順）。ツアーのタグとは独立 */
export function extractLandmarks(source: string, file: string): Landmark[] {
  return findTagged(source, '@landmark').map((t) => {
    if (!t.symbol)
      throw new Error(`${file}: @landmark の直後に宣言が見つかりません`);
    return {
      symbol: t.symbol,
      description: joinDescription(t.head, t.rest),
      file,
    };
  });
}

export function validateLandmarks(landmarks: Landmark[]): void {
  if (landmarks.length < 1) {
    throw new Error('見どころが 1 個もありません（5〜7 個に絞って選ぶ）');
  }
  if (landmarks.length > MAX_LANDMARKS) {
    throw new Error(
      `見どころが多すぎます（${landmarks.length} 個）。${MAX_LANDMARKS} 個以下、できれば 5〜7 個に絞ってください`,
    );
  }
}

const escapeCell = (text: string) => text.replace(/\|/g, '\\|');

/** 見どころの一覧（順序なし）を、表の Markdown にする。リンクは行番号を含めない */
export function renderMap(
  landmarks: Landmark[],
  meta: TourMeta,
  repoBase: string,
): string {
  const out: string[] = [`# ${meta.title}`, '', meta.intro, ''];
  out.push('| 見どころ | 場所 | 理由 |', '| :--- | :--- | :--- |');
  for (const m of landmarks) {
    out.push(
      `| \`${m.symbol}\` | [\`${m.file}\`](${repoBase}/${m.file}) | ${escapeCell(m.description)} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

const GENERATED_AT = /(generated:\s*\{[^}]*?at:\s*)[^\s,}]+/;

/** 生成日時（at）を除いて、内容が同じか比べる */
export function isUpToDate(existing: string, generated: string): boolean {
  const normalize = (s: string) => s.replace(GENERATED_AT, '$1<at>');
  return normalize(existing) === normalize(generated);
}
