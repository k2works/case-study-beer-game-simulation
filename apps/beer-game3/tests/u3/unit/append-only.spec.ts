import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? sourceFiles(full)
      : /\.(ts|tsx)$/.test(name)
        ? [full]
        : [];
  });
}

const SRC = path.resolve(import.meta.dirname, '../../../src');

describe('NFR9.2 履歴は追記専用（静的な検査）', () => {
  const files = sourceFiles(SRC).map((file) => ({ file, text: readFileSync(file, 'utf8') }));

  it('履歴の表に対する UPDATE、DELETE、TRUNCATE の文が、ソースに 1 つもない', () => {
    const forbidden =
      /(update\s+operation_log_entries|delete\s+from\s+operation_log_entries|truncate[^;`']*operation_log_entries)/i;
    const offenders = files.filter(({ text }) => forbidden.test(text)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('履歴の表への書き込みは INSERT の 1 か所（insertLog）だけ', () => {
    const inserts = files.flatMap(({ file, text }) =>
      [...text.matchAll(/insert\s+into\s+operation_log_entries/gi)].map(() => path.basename(file)),
    );
    expect(inserts).toEqual(['pg-store.ts']);
  });

  it('保存の関数は、履歴を足さずに状態を更新できない（updateGame は履歴の引数を必須にする）', () => {
    const store = files.find(({ file }) => file.endsWith('session/store.ts'))!.text;
    expect(store).toMatch(
      /updateGame\(\s*update: GameUpdate,\s*expectedVersion: number,\s*logs: readonly NewLogEntry\[\],?\s*\)/,
    );
    expect(store).not.toMatch(/appendLog/);
  });
});
