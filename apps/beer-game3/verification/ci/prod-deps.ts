/**
 * 本番の依存の検査（NFR6.4。cicd-pipeline.md「依存の置き場の検査と本番の依存の検査」）。
 * `npm ls --omit=dev --all --json` の結果に、検証のための依存（playwright、@playwright/*、axe-core、@axe-core/*）が
 * 含まれないことを確かめる。導入済みの木に対して、本番の依存だけに絞って調べる（導入し直さない）。
 *
 * このファイルは、Node.js が型を取り除いて直接実行する（依存なし。相対の import を持たない）。
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface NpmTree {
  dependencies?: Record<string, NpmTree>;
}

const FORBIDDEN = /^(playwright|playwright-core|@playwright\/.+|axe-core|@axe-core\/.+)$/;

/** 木のどこかにある、検証のための依存の名前（重複なし）。 */
export function findForbiddenDeps(tree: NpmTree): string[] {
  const found = new Set<string>();
  const walk = (node: NpmTree): void => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (FORBIDDEN.test(name)) {
        found.add(name);
      }
      walk(child);
    }
  };
  walk(tree);
  return [...found];
}

function readTree(): NpmTree {
  let output: string;
  try {
    output = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // npm ls は、木に問題があると終了コード 1 を返すが、木の JSON は標準出力に出す
    const stdout = (error as { stdout?: string | Buffer }).stdout;
    if (stdout === undefined) {
      throw error;
    }
    output = stdout.toString();
  }
  return JSON.parse(output) as NpmTree;
}

export function runCli(): number {
  const found = findForbiddenDeps(readTree());
  if (found.length > 0) {
    process.stdout.write(`本番の依存に検証のための依存が含まれています: ${found.join(', ')}\n`);
    return 1;
  }
  process.stdout.write('本番の依存に、検証のための依存は含まれていません\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli());
}
