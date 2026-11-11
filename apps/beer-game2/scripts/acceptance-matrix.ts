import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 対象の受入条件（docs/development/beer-game2/bolt_*_plan.md） */
export const TARGET = [
  'AC1.1.1',
  'AC1.1.2',
  'AC1.1.3',
  'AC1.1.4',
  'AC1.1.5',
  'AC1.1.6',
  'AC1.2.1',
  'AC1.2.2',
  'AC1.2.3',
  'AC1.2.4',
  'AC1.2.5',
  'AC1.3.1',
  'AC1.3.2',
  'AC1.3.3',
  'AC1.3.4',
  'AC2.1.1',
  'AC2.1.2',
  'AC2.1.3',
  'AC2.1.4',
  'AC2.2.1',
  'AC2.2.2',
  'AC2.2.3',
  'AC2.2.4',
  'AC2.3.1',
  'AC2.3.2',
  'AC2.3.3',
  'AC2.3.4',
  'AC2.3.5',
  'AC2.4.1',
  'AC2.4.2',
  'AC2.4.3',
  'AC2.4.4',
  'AC2.4.5',
  'AC3.1.1',
  'AC3.1.2',
  'AC3.1.3',
  'AC3.2.1',
  'AC3.2.2',
  'AC3.2.3',
  'AC3.2.4',
  'AC3.2.5',
  'AC4.1.1',
  'AC4.1.2',
  'AC4.1.3',
  'AC4.1.4',
  'AC4.1.5',
  'AC4.2.1',
  'AC4.2.2',
  'AC4.2.3',
  'AC4.2.4',
  'AC6.1.1',
  'AC6.1.2',
  'AC6.1.4',
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const TAG = /\[US(\d+\.\d+)\/(AC[\d.]+)\]/g;
const found = new Map<string, Set<string>>();
for (const file of walk('tests').filter((f) =>
  /\.(test\.tsx?|spec\.ts)$/.test(f),
)) {
  for (const m of readFileSync(file, 'utf8').matchAll(TAG)) {
    const files = found.get(m[2]!) ?? new Set<string>();
    files.add(file);
    found.set(m[2]!, files);
  }
}

const lines = [
  '| 受入条件 | テスト（ファイル） | 状態 |',
  '| :--- | :--- | :--- |',
];
const missing: string[] = [];
for (const ac of TARGET) {
  const files = [...(found.get(ac) ?? [])];
  if (files.length === 0) missing.push(ac);
  lines.push(
    `| ${ac} | ${files.join('<br>') || '—'} | ${files.length ? '対応あり' : '**未対応**'} |`,
  );
}
console.log(lines.join('\n'));
if (missing.length > 0) {
  console.error(`\n未対応の受入条件: ${missing.join(', ')}`);
  process.exit(1);
}
