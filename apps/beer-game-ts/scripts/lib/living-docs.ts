/**
 * イベント一覧・用語集・コアのハイライトの生成（Living Documentation）。
 *
 * - イベント: コードの共用体型（`GameEvent`・`SessionEvent`）が正本。設計書の表と突き合わせる。
 * - 用語: JSDoc の `@term 用語 | 定義 | 出典`。用語は設計書の「ユビキタス言語」の表にもあること。
 * - コア: JSDoc の `@core コンテキスト | なぜ核心か`。コンテキストは設計書で「中核」と分類されたものだけ。
 */
import { findTagged, joinDescription } from './guided-tour.js';

export interface EventDef {
  name: string;
  aggregate: string;
  fields: string[];
  /** apps/beer-game-ts からの相対パス */
  file: string;
}

const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** `{`・`(`・`[`・`<` の深さを数えながら、深さ 0 の区切り文字で分ける（`=>` の `>` は数えない） */
function splitTopLevel(text: string, separators: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if ('{([<'.includes(c)) depth++;
    else if ('})]'.includes(c) || (c === '>' && text[i - 1] !== '=')) depth--;
    if (depth === 0 && separators.includes(c)) {
      parts.push(current);
      current = '';
    } else current += c;
  }
  parts.push(current);
  return parts;
}

/** `export type <名前> = | { type: 'A'; ... } | ...;` の、各メンバーの名前と項目名を取り出す */
export function extractUnionEvents(
  source: string,
  file: string,
  unionName: string,
  aggregate: string,
): EventDef[] {
  const head = new RegExp(`export type ${unionName}\\s*=`).exec(source);
  if (!head) return [];
  const text = stripComments(source.slice(head.index + head[0].length));
  const end = splitTopLevel(text, ';')[0] ?? '';
  const members: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < end.length; i++) {
    if (end[i] === '{') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (end[i] === '}') {
      depth--;
      if (depth === 0) members.push(end.slice(start, i));
    }
  }
  return members.map((body) => {
    const segments = splitTopLevel(body, ';,').map((s) => s.trim());
    const nameMatch = /type:\s*'([A-Za-z0-9_]+)'/.exec(body);
    if (!nameMatch)
      throw new Error(`${file}: ${unionName} のメンバーに type がありません`);
    const fields = segments
      .map((s) => /^([A-Za-z0-9_]+)\??\s*:/.exec(s)?.[1])
      .filter((n): n is string => n !== undefined && n !== 'type');
    return { name: nameMatch[1]!, aggregate, fields, file };
  });
}

/** 見出し（`### ドメインイベント` など）の次の見出しまでの行 */
function sectionLines(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n');
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at < 0) return [];
  const rest = lines.slice(at + 1);
  const next = rest.findIndex((l) => l.startsWith('#'));
  return next < 0 ? rest : rest.slice(0, next);
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

/** 表の本文の行（見出し行と区切り行を除く）の、セルの配列 */
function tableRows(lines: string[], skipHeader = true): string[][] {
  const rows = lines
    .filter((l) => l.trimStart().startsWith('|'))
    .filter((l) => !/^\|\s*:?-{3,}/.test(l.trim()))
    .map(cells);
  return skipHeader ? rows.slice(1) : rows;
}

/** 設計書の「ドメインイベント」の表の、イベント名（「、」で並べたものを分ける） */
export function extractDesignEvents(markdown: string): string[] {
  return tableRows(sectionLines(markdown, '### ドメインイベント')).flatMap(
    (row) =>
      (row[0] ?? '')
        .split('、')
        .map((n) => n.trim())
        .filter((n) => n.length > 0),
  );
}

export interface EventComparison {
  /** コードにあって、設計書の表に無い（誤り） */
  codeOnly: string[];
  /** 設計書にあって、コードにまだ無い（一覧に載せる） */
  designOnly: string[];
}

export function compareEvents(
  events: EventDef[],
  designNames: string[],
): EventComparison {
  const code = events.map((e) => e.name);
  const duplicated = code.filter((n, i) => code.indexOf(n) !== i);
  if (duplicated.length > 0) {
    throw new Error(`イベント名が重複しています: ${duplicated.join('、')}`);
  }
  return {
    codeOnly: code.filter((n) => !designNames.includes(n)),
    designOnly: designNames.filter((n) => !code.includes(n)),
  };
}

const escapeCell = (text: string) => text.replace(/\|/g, '\\|');
const link = (file: string, repoBase: string) =>
  `[\`${file}\`](${repoBase}/${file})`;
const codeList = (items: string[]) =>
  items.length === 0 ? 'なし' : items.map((i) => `\`${i}\``).join('、');

export function renderEvents(
  events: EventDef[],
  comparison: EventComparison,
  repoBase: string,
): string {
  const out = [
    '# イベント一覧（生成）',
    '',
    '> **自動生成**: このファイルは `npm run docs:living` で、コードの共用体型（`GameEvent`・`SessionEvent`）から生成しています。直接編集せず、コードを直してください（CI が、コードとの一致と、設計書の表との不一致を検査します）。',
    '',
    `実装済みのドメインイベント ${events.length} 種類。名前が [ドメインモデル設計](../domain-model.md) の「ドメインイベント」の表に無いときは、検査が失敗します。発行する契機は、設計書の表を参照してください。`,
    '',
    '| イベント | 集約 | ペイロードの項目 | 場所 |',
    '| :--- | :--- | :--- | :--- |',
  ];
  for (const e of events) {
    out.push(
      `| \`${e.name}\` | ${e.aggregate} | ${codeList(e.fields)} | ${link(e.file, repoBase)} |`,
    );
  }
  if (comparison.designOnly.length > 0) {
    out.push('', '## 設計書にあり、まだ実装が無いイベント', '');
    for (const n of comparison.designOnly) out.push(`- \`${n}\``);
  }
  out.push('');
  return out.join('\n');
}

export interface TermDef {
  term: string;
  definition: string;
  source: string;
  symbol: string;
  file: string;
}

export function extractTerms(source: string, file: string): TermDef[] {
  return findTagged(source, '@term').map((t) => {
    const parts = joinDescription(t.head, t.rest)
      .split(' | ')
      .map((p) => p.trim());
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
      throw new Error(
        `${file}: @term は「用語 | 定義 | 出典」の 3 項目にします: ${t.head}`,
      );
    }
    if (!t.symbol)
      throw new Error(`${file}: @term（${parts[0]}）の直後に宣言がありません`);
    return {
      term: parts[0]!,
      definition: parts[1]!,
      source: parts[2]!,
      symbol: t.symbol,
      file,
    };
  });
}

/** 設計書の「ユビキタス言語」の表の、用語（太字は外す。「・」で並べたものは、全体と各部分を含める） */
export function extractDesignTerms(markdown: string): string[] {
  return tableRows(sectionLines(markdown, '## ユビキタス言語')).flatMap(
    (row) => {
      const name = (row[0] ?? '').replace(/\*/g, '').trim();
      return [name, ...name.split('・')].filter((n) => n.length > 0);
    },
  );
}

export function validateTerms(terms: TermDef[], designTerms: string[]): void {
  const names = terms.map((t) => t.term);
  const duplicated = names.filter((n, i) => names.indexOf(n) !== i);
  if (duplicated.length > 0) {
    throw new Error(`用語が重複しています: ${duplicated.join('、')}`);
  }
  const unknown = names.filter((n) => !designTerms.includes(n));
  if (unknown.length > 0) {
    throw new Error(
      `設計書の「ユビキタス言語」の表に無い用語です（名前が変わった可能性）: ${unknown.join('、')}`,
    );
  }
}

export function renderGlossary(terms: TermDef[], repoBase: string): string {
  const sorted = [...terms].sort((a, b) => a.term.localeCompare(b.term, 'ja'));
  const out = [
    '# 用語集（生成）',
    '',
    '> **自動生成**: このファイルは `npm run docs:living` で、コードの `@term` から生成しています。直接編集せず、コードのタグを直してください（CI が、コードとの一致と、設計書の用語との不一致を検査します）。',
    '',
    `注釈 \`@term\` を付けた宣言の ${terms.length} 項目。これから書くコードと、新しく足す概念から付け始めます（既存コードへの一括適用はしません）。全体のユビキタス言語は [ドメインモデル設計](../domain-model.md) を参照してください。`,
    '',
    '| 用語 | コード上の名称 | 定義 | 出典 |',
    '| :--- | :--- | :--- | :--- |',
  ];
  for (const t of sorted) {
    out.push(
      `| ${escapeCell(t.term)} | \`${t.symbol}\`（${link(t.file, repoBase)}） | ${escapeCell(t.definition)} | ${escapeCell(t.source)} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

export interface CoreDef {
  context: string;
  reason: string;
  symbol: string;
  file: string;
}

export const MAX_CORES = 10;

export function extractCores(source: string, file: string): CoreDef[] {
  return findTagged(source, '@core').map((t) => {
    const parts = joinDescription(t.head, t.rest)
      .split(' | ')
      .map((p) => p.trim());
    if (parts.length !== 2 || parts.some((p) => p.length === 0)) {
      throw new Error(
        `${file}: @core は「コンテキスト | なぜ核心か」の 2 項目にします: ${t.head}`,
      );
    }
    if (!t.symbol)
      throw new Error(`${file}: @core（${parts[0]}）の直後に宣言がありません`);
    return {
      context: parts[0]!,
      reason: parts[1]!,
      symbol: t.symbol,
      file,
    };
  });
}

/** 設計書の境界付けられたコンテキストの表で、分類が「中核」のコンテキスト（設計書の順） */
export function extractCoreContexts(markdown: string): string[] {
  return tableRows(markdown.split('\n'), false)
    .filter((row) => row[1] === '中核')
    .map((row) => row[0]!);
}

export function validateCores(cores: CoreDef[], contexts: string[]): void {
  if (contexts.length === 0)
    throw new Error('設計書に、分類が「中核」のコンテキストが見つかりません');
  if (cores.length > MAX_CORES) {
    throw new Error(
      `@core が多すぎます（${cores.length} 個）。${MAX_CORES} 個以下に絞ってください`,
    );
  }
  const outside = cores.filter((c) => !contexts.includes(c.context));
  if (outside.length > 0) {
    throw new Error(
      `@core のコンテキストが、設計書の「中核」（${contexts.join('・')}）にありません: ${outside.map((c) => `${c.symbol}（${c.context}）`).join('、')}。補完・一般のコンテキストには付けません`,
    );
  }
}

export function renderCore(
  cores: CoreDef[],
  contexts: string[],
  events: EventDef[],
  repoBase: string,
): string {
  const out = [
    '# コアのハイライト（生成）',
    '',
    '> **自動生成**: このファイルは `npm run docs:living` で、コードの `@core` から生成しています。直接編集せず、コードのタグを直してください。',
    '',
    `**ここが核心。** このゲームの中核は、${contexts.join('と、')}。新しく参加する人は、まず下の ${cores.length} つを読んでください。`,
    '',
    `選び方: 注釈 \`@core\` を付けた宣言だけを、コンテキストごとに示します（名前や場所は名指ししません。改名や移動に追従します）。中核かどうかは、[ドメインモデル設計](../domain-model.md) の「戦略的設計」が正本で、補完・一般のコンテキストの宣言は載せません（検査が失敗します）。付ける数は ${MAX_CORES} 個以内です。`,
    '',
  ];
  for (const context of contexts) {
    const group = cores.filter((c) => c.context === context);
    if (group.length === 0) continue;
    out.push(
      `## ${context}`,
      '',
      '| 名前 | 場所 | なぜ核心か |',
      '| :--- | :--- | :--- |',
    );
    for (const c of group) {
      out.push(
        `| \`${c.symbol}\` | ${link(c.file, repoBase)} | ${escapeCell(c.reason)} |`,
      );
    }
    out.push('');
  }
  out.push(
    `コアが事実として残すイベント（[イベント一覧](./events.md)）: ${codeList(events.map((e) => e.name))}`,
    '',
  );
  return out.join('\n');
}
