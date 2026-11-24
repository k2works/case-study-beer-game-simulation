import { describe, expect, it } from 'vitest';
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
} from '../../scripts/lib/living-docs.js';

const unionSource = `
/** 説明 */
export type GameEvent =
  | { type: 'GameCreated'; gameId: string; changes: readonly Item[] }
  | { type: 'Joined'; gameId: string; map?: Record<Role, readonly string[]> }
  | {
      type: 'Replaced';
      /** 外された旧担当者 */
      replacedIds: readonly string[];
      fn: (a: number) => void;
    };

export interface Other {}
`;

const design = `
## ユビキタス言語

| 用語 | 英語 | 定義 |
| :--- | :--- | :--- |
| ゲーム | Game | ... |
| **共同担当** | Co | ... |
| 注文遅延・配送遅延 | Delay | ... |

## 戦略的設計

| コンテキスト | 分類 | 理由 |
| :--- | :--- | :--- |
| 計算 | 中核 | x |
| 準備 | 補完 | y |
| 進行 | 中核 | z |

### ドメインイベント

| イベント | 集約 | 契機 |
| :--- | :--- | :--- |
| GameCreated | Game | 作成 |
| Joined、Replaced | Game | 参加 |
| NotYet | Game | 未実装 |

## 次の節
`;

describe('イベント一覧の生成', () => {
  it('共用体型のメンバーの名前と項目名を取り出す（入れ子の型・コメント・関数型を含む）', () => {
    const events = extractUnionEvents(unionSource, 'a.ts', 'GameEvent', 'Game');
    expect(events.map((e) => [e.name, e.fields])).toEqual([
      ['GameCreated', ['gameId', 'changes']],
      ['Joined', ['gameId', 'map']],
      ['Replaced', ['replacedIds', 'fn']],
    ]);
  });

  it('設計書の表のイベント名を、「、」で分けて取り出す', () => {
    expect(extractDesignEvents(design)).toEqual([
      'GameCreated',
      'Joined',
      'Replaced',
      'NotYet',
    ]);
  });

  it('コードだけにあるイベントと、設計書だけにあるイベントを分ける', () => {
    const events = extractUnionEvents(unionSource, 'a.ts', 'GameEvent', 'Game');
    expect(compareEvents(events, ['GameCreated', 'NotYet'])).toEqual({
      codeOnly: ['Joined', 'Replaced'],
      designOnly: ['NotYet'],
    });
  });

  it('同じ名前のイベントが重複したら誤りにする', () => {
    const events = extractUnionEvents(unionSource, 'a.ts', 'GameEvent', 'Game');
    expect(() => compareEvents([...events, ...events], [])).toThrow('重複');
  });

  it('設計書にあって未実装のイベントを一覧に載せる', () => {
    const events = extractUnionEvents(unionSource, 'a.ts', 'GameEvent', 'Game');
    const body = renderEvents(
      events,
      { codeOnly: [], designOnly: ['NotYet'] },
      'https://example/blob',
    );
    expect(body).toContain('| `GameCreated` | Game |');
    expect(body).toContain('## 設計書にあり、まだ実装が無いイベント');
    expect(body).toContain('- `NotYet`');
  });
});

const termSource = `
/**
 * @term ゲーム | 実施単位 | ドメインモデル
 */
export interface Game {}
`;

describe('用語集の生成', () => {
  it('@term から、用語・定義・出典・宣言の名前を取り出す', () => {
    expect(extractTerms(termSource, 'g.ts')).toEqual([
      {
        term: 'ゲーム',
        definition: '実施単位',
        source: 'ドメインモデル',
        symbol: 'Game',
        file: 'g.ts',
      },
    ]);
  });

  it('3 項目でない @term・宣言の無い @term は誤りにする', () => {
    expect(() =>
      extractTerms(
        '/**\n * @term ゲーム | 定義だけ\n */\nexport const a = 1;',
        'g.ts',
      ),
    ).toThrow('3 項目');
    expect(() =>
      extractTerms('/**\n * @term ゲーム | 定義 | 出典\n */\n', 'g.ts'),
    ).toThrow('宣言');
  });

  it('設計書のユビキタス言語の用語（太字・「・」区切りを含む）を取り出す', () => {
    expect(extractDesignTerms(design)).toEqual([
      'ゲーム',
      'ゲーム',
      '共同担当',
      '共同担当',
      '注文遅延・配送遅延',
      '注文遅延',
      '配送遅延',
    ]);
  });

  it('設計書に無い用語・重複した用語は誤りにする', () => {
    const [term] = extractTerms(termSource, 'g.ts');
    expect(() => validateTerms([term!], ['ゲーム'])).not.toThrow();
    expect(() => validateTerms([term!], ['別の用語'])).toThrow('表に無い');
    expect(() => validateTerms([term!, term!], ['ゲーム'])).toThrow('重複');
  });

  it('用語を並べた表にする', () => {
    const body = renderGlossary(extractTerms(termSource, 'g.ts'), 'https://x');
    expect(body).toContain(
      '| ゲーム | `Game`（[`g.ts`](https://x/g.ts)） | 実施単位 |',
    );
  });
});

const coreSource = (context: string) =>
  `/**\n * @core ${context} | 理由\n */\nexport function f() {}\n`;

describe('コアのハイライトの生成', () => {
  it('設計書の「中核」のコンテキストだけを、設計書の順に取り出す', () => {
    expect(extractCoreContexts(design)).toEqual(['計算', '進行']);
  });

  it('中核のコンテキストの @core は通り、補完のコンテキストは誤りにする', () => {
    const contexts = ['計算', '進行'];
    expect(() =>
      validateCores(extractCores(coreSource('計算'), 'f.ts'), contexts),
    ).not.toThrow();
    expect(() =>
      validateCores(extractCores(coreSource('準備'), 'f.ts'), contexts),
    ).toThrow('中核');
  });

  it('上限（10 個）を超えたら誤りにする', () => {
    const cores = Array.from({ length: 11 }, () => ({
      context: '計算',
      reason: 'r',
      symbol: 'f',
      file: 'f.ts',
    }));
    expect(() => validateCores(cores, ['計算'])).toThrow('多すぎ');
  });

  it('2 項目でない @core は誤りにする', () => {
    expect(() =>
      extractCores('/**\n * @core 計算\n */\nexport const a = 1;', 'f.ts'),
    ).toThrow('2 項目');
  });

  it('コンテキストごとに表にする', () => {
    const cores = extractCores(coreSource('計算'), 'f.ts');
    const body = renderCore(cores, ['計算', '進行'], [], 'https://x');
    expect(body).toContain('## 計算');
    expect(body).not.toContain('## 進行');
    expect(body).toContain('| `f` | [`f.ts`](https://x/f.ts) | 理由 |');
  });
});
