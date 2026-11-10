/**
 * ガイドツアーと、サイトシーイング・マップを、コードのタグから生成する（Living Documentation）。
 * - ガイドツアー: `@guidedTour <ツアー名> <順序> <説明>`（順序のある、処理の流れの案内）
 * - サイトシーイング・マップ: `@landmark <説明>`（順序のない、見どころの一覧。5〜7 個に絞る）
 *
 *   npm run docs:tour         生成する（docs/ の該当ファイルを更新）
 *   npm run docs:tour:check   生成物がコードと一致しているか検査する（不一致なら失敗。CI で使う）
 *
 * タグは、宣言の JSDoc に付ける。ツアーの順序は 10 刻みにする（途中に足せるように）。
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
  extractLandmarks,
  extractSteps,
  groupTours,
  isUpToDate,
  renderMap,
  renderTour,
  validateLandmarks,
  type Landmark,
  type TourMeta,
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

function sources(): { file: string; text: string }[] {
  return SCAN_DIRS.flatMap(walk)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .sort()
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }));
}

const MAP: TourConfig = {
  title: 'サイトシーイング・マップ（見どころ）',
  description:
    'コードベースの見どころ（ここを理解すれば全体が分かる場所）の一覧。順序はない。コードのタグから自動生成する。',
  output: '../../docs/design/beer-game2/sightseeing-map.md',
  intro: [
    '> **自動生成**: このファイルは `npm run docs:tour` で、コードの `@landmark` から生成しています。直接編集せず、コードのタグを直してください（CI が、コードとの一致を検査します）。',
    '',
    '初めてコードを読むときの地図です。**ここを理解すれば全体が分かる**場所だけを、少数に絞っています。',
    '処理の流れを順にたどりたいときは、[ガイドツアー](./guided-tour-walking-skeleton.md) を使ってください。',
  ].join('\n'),
};

function frontMatter(config: TourConfig, by: string, at: string): string {
  return [
    '---',
    'type: Design',
    `title: "${config.title}"`,
    `description: "${config.description}"`,
    'tags: [design, living-documentation]',
    'status: draft',
    `generated: { by: "${by}", at: ${at} }`,
    '---',
    '',
  ].join('\n');
}

const check = process.argv.includes('--check');
const all = sources();
const tours = groupTours(all.flatMap((f) => extractSteps(f.text, f.file)));
const landmarks: Landmark[] = all.flatMap((f) =>
  extractLandmarks(f.text, f.file),
);
let stale = false;

/** 生成物を書く。または（--check）コードと一致しているかを検査する */
function emit(
  label: string,
  config: TourConfig,
  by: string,
  body: string,
  count: number,
) {
  const existing = existsSync(config.output)
    ? readFileSync(config.output, 'utf8')
    : '';
  const existingAt =
    /at:\s*([^\s,}]+)/.exec(existing)?.[1] ?? new Date().toISOString();
  const generated = `${frontMatter(config, by, existingAt)}${body}`;
  if (existing && isUpToDate(existing, generated)) {
    console.log(`✓ ${label}: 最新（${count} 件）`);
    return;
  }
  if (check) {
    console.error(
      `✗ ${label}: 生成物がコードと一致しません。npm run docs:tour で再生成してください`,
    );
    stale = true;
    return;
  }
  const at = new Date().toISOString();
  writeFileSync(config.output, `${frontMatter(config, by, at)}${body}`);
  console.log(`✓ ${label}: 生成しました（${count} 件）→ ${config.output}`);
}

for (const [name, config] of Object.entries(TOURS)) {
  const steps = tours.get(name);
  if (!steps || steps.length === 0)
    throw new Error(`ツアー ${name} に、タグの付いた宣言がありません`);
  emit(
    `ガイドツアー ${name}`,
    config,
    `script:apps/beer-game2/scripts/guided-tour.ts (${name})`,
    renderTour(steps, config, REPO_BASE),
    steps.length,
  );
}

validateLandmarks(landmarks);
emit(
  'サイトシーイング・マップ',
  MAP,
  'script:apps/beer-game2/scripts/guided-tour.ts (sightseeing-map)',
  renderMap(landmarks, MAP, REPO_BASE),
  landmarks.length,
);

const unknown = [...tours.keys()].filter((t) => !(t in TOURS));
if (unknown.length > 0) {
  console.error(`✗ 設定の無いツアー名: ${unknown.join(', ')}`);
  stale = true;
}
if (stale) process.exit(1);
