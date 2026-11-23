// 型の生成物の差分検査。contracts/openapi.yaml から型を生成し直し、コミット済みの
// src/api/generated/schema.d.ts と一致すること（差分 0）を確かめる。仕様を直して型の再生成を忘れると失敗する。
// 使い方: npm run api:check（修正は npm run api:generate）
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SPEC = '../beer-game-contracts/openapi.yaml';
const COMMITTED = 'src/api/generated/schema.d.ts';

const dir = mkdtempSync(join(tmpdir(), 'api-check-'));
try {
    const generated = join(dir, 'schema.d.ts');
    execFileSync('npx', ['openapi-typescript', SPEC, '-o', generated], { stdio: 'pipe' });
    // コミット済みの生成物は、生成の後に prettier で整形している（api:generate）。同じ整形を通して比べる。
    const formatted = execFileSync('npx', ['prettier', '--stdin-filepath', COMMITTED], {
        input: readFileSync(generated),
    }).toString();
    const committed = readFileSync(COMMITTED, 'utf8');
    if (formatted !== committed) {
        console.error(
            `${COMMITTED} が ${SPEC} から生成した内容と一致しません。npm run api:generate を実行してください。`,
        );
        process.exit(1);
    }
    console.log(`${COMMITTED} は ${SPEC} から生成した内容と一致します（差分 0）。`);
} finally {
    rmSync(dir, { recursive: true, force: true });
}
