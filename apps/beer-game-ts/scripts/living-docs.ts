/**
 * イベント一覧・用語集・コアのハイライトを、コードから生成する（Living Documentation）。
 * ガイドツアーとマップは `guided-tour.ts`。ここは、設計書との突き合わせを伴う 3 つ。
 *
 *   npm run docs:living         生成する（docs/design/beer-game-ts/generated/ を更新）
 *   npm run docs:living:check   生成物がコードと一致しているか、設計書と矛盾しないかを検査する（CI で使う）
 *
 * - イベント: `src/domain/game.ts`・`session.ts` の共用体型 `GameEvent`・`SessionEvent`（設計書の表と突き合わせる）
 * - 用語: JSDoc の `@term 用語 | 定義 | 出典`
 * - コア: JSDoc の `@core コンテキスト | なぜ核心か`
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isUpToDate } from './lib/guided-tour.js';
import {
  compareEvents,
  extractCoreContexts,
  extractCores,
  extractDesignEvents,
  extractDesignTerms,
  extractTerms,
  extractUnionEvents,
  renderCore,
  renderEvents,
  renderGlossary,
  validateCores,
  validateTerms,
} from './lib/living-docs.js';

const REPO_BASE =
  'https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts';
const DESIGN = '../../docs/design/beer-game-ts';
const OUTPUT = `${DESIGN}/generated`;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sources = walk('src')
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .sort()
  .map((file) => ({ file, text: readFileSync(file, 'utf8') }));
const sourceOf = (file: string) => {
  const found = sources.find((s) => s.file === file);
  if (!found) throw new Error(`${file} が見つかりません`);
  return found;
};

const design = readFileSync(`${DESIGN}/domain-model.md`, 'utf8');

const events = [
  ...extractUnionEvents(
    sourceOf('src/domain/game.ts').text,
    'src/domain/game.ts',
    'GameEvent',
    'Game',
  ),
  ...extractUnionEvents(
    sourceOf('src/domain/session.ts').text,
    'src/domain/session.ts',
    'SessionEvent',
    'Session',
  ),
];
if (events.length === 0) throw new Error('イベントを 1 つも取り出せません');
const comparison = compareEvents(events, extractDesignEvents(design));
if (comparison.codeOnly.length > 0) {
  throw new Error(
    `設計書の「ドメインイベント」の表に無いイベントがあります: ${comparison.codeOnly.join('、')}`,
  );
}

const terms = sources.flatMap((s) => extractTerms(s.text, s.file));
validateTerms(terms, extractDesignTerms(design));

const cores = sources.flatMap((s) => extractCores(s.text, s.file));
const contexts = extractCoreContexts(design);
validateCores(cores, contexts);

interface Doc {
  file: string;
  title: string;
  description: string;
  body: string;
}

const docs: Doc[] = [
  {
    file: 'events.md',
    title: 'イベント一覧（生成）',
    description:
      'ドメインイベントの一覧。コードの共用体型から生成した。手で編集しない。',
    body: renderEvents(events, comparison, REPO_BASE),
  },
  {
    file: 'glossary.md',
    title: '用語集（生成）',
    description:
      'ユビキタス言語の用語集。コードの注釈 @term から生成した。手で編集しない。',
    body: renderGlossary(terms, REPO_BASE),
  },
  {
    file: 'core-highlight.md',
    title: 'コアのハイライト（生成）',
    description:
      'ドメインの中核の主要な宣言を、注釈 @core から動的に選び出した、新しく参加する人の読む入口。手で編集しない。',
    body: renderCore(cores, contexts, events, REPO_BASE),
  },
];

const frontMatter = (doc: Doc, at: string) =>
  [
    '---',
    'type: Design',
    `title: "${doc.title}"`,
    `description: "${doc.description}"`,
    'tags: [design, living-documentation, generated]',
    'status: draft',
    `generated: { by: "script:apps/beer-game-ts/scripts/living-docs.ts", at: ${at} }`,
    '---',
    '',
  ].join('\n');

const check = process.argv.includes('--check');
let stale = false;
for (const doc of docs) {
  const path = `${OUTPUT}/${doc.file}`;
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const existingAt =
    /at:\s*([^\s,}]+)/.exec(existing)?.[1] ?? new Date().toISOString();
  if (
    existing &&
    isUpToDate(existing, `${frontMatter(doc, existingAt)}${doc.body}`)
  ) {
    console.log(`✓ ${doc.file}: 最新`);
    continue;
  }
  if (check) {
    console.error(
      `✗ ${doc.file}: 生成物がコードと一致しません。npm run docs:living で再生成してください`,
    );
    stale = true;
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${frontMatter(doc, new Date().toISOString())}${doc.body}`,
  );
  console.log(`✓ ${doc.file}: 生成しました → ${path}`);
}
if (stale) process.exit(1);
