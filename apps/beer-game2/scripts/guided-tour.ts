/**
 * ガイドツアーを、コードの `@guidedTour` から生成する（Living Documentation）。
 *
 *   npm run docs:tour         生成する（docs/ の該当ファイルを更新）
 *   npm run docs:tour:check   生成物がコードと一致しているか検査する（不一致なら失敗。CI で使う）
 *
 * タグの書き方: 宣言の JSDoc に `@guidedTour <ツアー名> <順序> <説明>`（順序は 10 刻み）。
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  extractSteps,
  groupTours,
  isUpToDate,
  renderTour,
  type TourMeta,
  type TourStep,
} from './lib/guided-tour.js';

const REPO_BASE =
  'https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game2';
const SCAN_DIRS = ['src', 'ui/src', 'tests/e2e'];

interface TourConfig extends TourMeta {
  output: string;
  description: string;
}

const TOURS: Record<string, TourConfig> = {
  'walking-skeleton': {
    title:
      'ガイドツアー: ウォーキングスケルトン（発注の保存から、1 週が確定するまで）',
    description:
      'ウォーキングスケルトンの縦の流れ（画面 → API → ユースケース → 集約 → 計算 → 永続化 → 通知）を、順にたどるガイドツアー。コードのタグから自動生成する。',
    output: '../../docs/design/beer-game2/guided-tour-walking-skeleton.md',
    intro: [
      '> **自動生成**: このファイルは `npm run docs:tour` で、コードの `@guidedTour` から生成しています。直接編集せず、コードのタグを直してください（CI が、コードとの一致を検査します）。',
      '',
      'ウォーキングスケルトン（Bolt 1）は、ゲームの作成から確定までを、画面からデータベースまで縦に通した最小の実装です。',
      'このツアーは、その中心の流れ「参加者が発注を保存し、1 週が確定して、全員の画面が更新される」を、入口から出口まで順にたどります。',
      '初めてコードを読む人は、ここから始めて、各ステップのファイルを開いてください。',
      '',
      '全体の構造は [バックエンドのアーキテクチャ](./architecture-backend.md)、層の依存の理由は [ADR-003](../../adr/beer-game2/003-ports-and-adapters-with-lint.md) を参照してください。',
    ].join('\n'),
  },
};

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function collect(): TourStep[] {
  return SCAN_DIRS.flatMap(walk)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .sort()
    .flatMap((file) => extractSteps(readFileSync(file, 'utf8'), file));
}

function document(
  name: string,
  config: TourConfig,
  steps: TourStep[],
  at: string,
): string {
  const front = [
    '---',
    'type: Design',
    `title: "${config.title}"`,
    `description: "${config.description}"`,
    'tags: [design, living-documentation]',
    'status: draft',
    `generated: { by: "script:apps/beer-game2/scripts/guided-tour.ts (${name})", at: ${at} }`,
    '---',
    '',
  ].join('\n');
  return `${front}${renderTour(steps, config, REPO_BASE)}`;
}

const check = process.argv.includes('--check');
const tours = groupTours(collect());
let stale = false;

for (const [name, config] of Object.entries(TOURS)) {
  const steps = tours.get(name);
  if (!steps || steps.length === 0)
    throw new Error(`ツアー ${name} に、タグの付いた宣言がありません`);
  const existing = existsSync(config.output)
    ? readFileSync(config.output, 'utf8')
    : '';
  const existingAt =
    /at:\s*([^\s,}]+)/.exec(existing)?.[1] ?? new Date().toISOString();
  const generated = document(name, config, steps, existingAt);

  if (existing && isUpToDate(existing, generated)) {
    console.log(`✓ ${name}: 最新（${steps.length} ステップ）`);
    continue;
  }
  if (check) {
    console.error(
      `✗ ${name}: 生成物がコードと一致しません。npm run docs:tour で再生成してください`,
    );
    stale = true;
    continue;
  }
  writeFileSync(
    config.output,
    document(name, config, steps, new Date().toISOString()),
  );
  console.log(
    `✓ ${name}: 生成しました（${steps.length} ステップ）→ ${config.output}`,
  );
}

const unknown = [...tours.keys()].filter((t) => !(t in TOURS));
if (unknown.length > 0) {
  console.error(`✗ 設定の無いツアー名: ${unknown.join(', ')}`);
  stale = true;
}
if (stale) process.exit(1);
