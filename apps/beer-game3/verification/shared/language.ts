/**
 * 画面の文言に英語の文が混じっていないかの検査（NFR11.1）。Vitest の文言の一覧の検査と、
 * Playwright の表示された文言の検査の両方が使う。
 *
 * 英語の文 = 英字だけの語（2 文字以上）が空白 1 つで 3 語以上続く並び。識別子（camelCase、snake_case など）と
 * 短い略語（CSV、JSON など）、金額の記号は対象から除く（識別子は出力の列名と役割の値などで英語のまま使う）。
 */

const WORD = /^[A-Za-z][a-z]+$/;
const MIN_RUN = 3;

/** 英語の語として数えない（識別子や略語として英語のまま使う）語。 */
const ALLOWED = new Set(['kit', 'custom', 'participant', 'facilitator', 'week', 'role']);

function isEnglishWord(token: string): boolean {
  if (!WORD.test(token)) {
    return false;
  }
  return !ALLOWED.has(token.toLowerCase());
}

/** 英語の文と見なした並びの一覧。空なら混じっていない。 */
export function findEnglishSentences(text: string): string[] {
  const tokens = text
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''));
  const found: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= MIN_RUN) {
      found.push(run.join(' '));
    }
    run = [];
  };
  for (const token of tokens) {
    if (isEnglishWord(token)) {
      run.push(token);
    } else {
      flush();
    }
  }
  flush();
  return found;
}
