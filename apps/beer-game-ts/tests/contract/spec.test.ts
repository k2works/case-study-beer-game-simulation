import { describe, expect, it } from 'vitest';
import {
  BASE_PATH,
  expectConforms,
  operations,
  schemaNames,
  violations,
} from './spec.js';

// 契約の読み込みと、検証の道具そのものの確かめ（道具が壊れていて、何でも通すことを防ぐ）
describe('共有する API の契約の読み込み', () => {
  it('契約のパスの接頭辞は /api/v1', () => {
    expect(BASE_PATH).toBe('/api/v1');
  });

  it('契約の操作は 25 件で、operationId は重複しない', () => {
    const ids = operations().map((o) => o.operationId);
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Fastify のルートの形（:param）に変換できる', () => {
    const lobby = operations().find((o) => o.operationId === 'getLobby');
    expect(lobby?.routeUrl).toBe('/api/v1/games/:gameId/lobby');
  });

  it('契約の全スキーマが、参照を解決してコンパイルできる', () => {
    for (const name of schemaNames()) {
      // 空のオブジェクトで検証して、スキーマの参照が解決できることだけを確かめる（適合かどうかは問わない）
      expect(() => violations(name, {})).not.toThrow();
    }
  });
});

describe('契約のスキーマによる検証', () => {
  it('適合する応答を通す', () => {
    expect(() =>
      expectConforms('CommandResponse', {
        versions: { game: 3, session: null },
      }),
    ).not.toThrow();
  });

  it('必須の項目が無い応答を落とす', () => {
    expect(violations('CommandResponse', {})).not.toEqual([]);
  });

  it('型の違う応答を落とす（版は整数または null）', () => {
    expect(
      violations('CommandResponse', { versions: { game: 'x', session: 1 } }),
    ).not.toEqual([]);
  });

  it('allOf で合成したスキーマも検証する（作成の応答は復帰コードが必須）', () => {
    expect(
      violations('CreateGameResponse', {
        versions: { game: 0, session: null },
      }),
    ).not.toEqual([]);
    expect(
      violations('CreateGameResponse', {
        versions: { game: 0, session: null },
        recoveryCode: 'RC-1',
      }),
    ).toEqual([]);
  });

  it('format: uuid を検証する', () => {
    expect(
      violations('JoinResponse', {
        versions: { game: 1, session: null },
        gameId: 'not-a-uuid',
      }),
    ).not.toEqual([]);
  });
});
