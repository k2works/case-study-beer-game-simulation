import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from '../../../src/web/api.js';

const credential = { kind: 'facilitator', secret: 'fac_abc', gameId: 'g 1' } as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('API クライアント（結果と出力）', () => {
  it('結果は GET /results、資格情報は Authorization ヘッダで送り、URL には載せない', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { confirmedWeeks: 0 }));
    const view = await createApi(fetchMock).getResults(credential);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/games/g%201/results');
    expect(url).not.toContain('fac_abc');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ authorization: 'Bearer fac_abc' });
    expect(view).toEqual({ confirmedWeeks: 0 });
  });

  it('出力はヘッダ付きの取得で、format を URL に、資格情報をヘッダに置き、Blob とファイル名を返す', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('﻿gameId\r\n', {
          status: 200,
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="beer-game-g1.csv"',
          },
        }),
    );
    const file = await createApi(fetchMock).exportGame(credential, 'csv');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/games/g%201/export?format=csv');
    expect(url).not.toContain('fac_abc');
    expect(init.headers).toMatchObject({ authorization: 'Bearer fac_abc' });
    expect(file.filename).toBe('beer-game-g1.csv');
    expect(await file.blob.text()).toContain('gameId');
  });

  it('ファイル名の指定が無い応答は、既定の名前にする', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const file = await createApi(fetchMock).exportGame(credential, 'json');
    expect(file.filename).toBe('beer-game.json');
  });

  it('出力の失敗（409 など）は、Problem のまま ApiError にする', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(409, { kind: 'state', reason: '終了していません', hint: '終了してください' }),
    );
    const error = await createApi(fetchMock)
      .exportGame(credential, 'csv')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('state');
    expect((error as ApiError).problem?.hint).toBe('終了してください');
  });

  it('通信できなかったときは network、本文が Problem でないときは internal', async () => {
    const down = createApi(
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(
      ((await down.exportGame(credential, 'csv').catch((e: unknown) => e)) as ApiError).kind,
    ).toBe('network');
    const odd = createApi(vi.fn(async () => new Response('oops', { status: 500 })));
    expect(
      ((await odd.exportGame(credential, 'csv').catch((e: unknown) => e)) as ApiError).kind,
    ).toBe('internal');
  });
});
