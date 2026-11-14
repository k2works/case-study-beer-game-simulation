// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportPanel, saveBlob } from '../../../src/web/screens/ExportPanel.js';
import { facilitatorCredential, fakeApi } from '../../u1/web/support.js';

const created: string[] = [];
const revoked: string[] = [];
let clicks: Array<{ href: string; download: string }> = [];

beforeEach(() => {
  clicks = [];
  created.length = 0;
  revoked.length = 0;
  URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
    created.push(String((blob as Blob).size));
    return 'blob:test-url';
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ブラウザのダウンロードとして保存する', () => {
  it('saveBlob: Blob の URL を作ってリンクを押し、後始末をする（DOM にリンクを残さない）', () => {
    saveBlob(new Blob(['abc']), 'beer-game-g1.csv');
    expect(created).toEqual(['3']);
    expect(clicks).toEqual([{ href: 'blob:test-url', download: 'beer-game-g1.csv' }]);
    expect(revoked).toEqual(['blob:test-url']);
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('既定の保存を使う ExportPanel は、出力ボタンでファイルを保存する', async () => {
    const api = fakeApi({
      exportGame: async () => ({ blob: new Blob(['x']), filename: 'beer-game-g1.json' }),
    });
    render(<ExportPanel api={api} credential={facilitatorCredential} />);
    await userEvent.click(screen.getByTestId('export-json'));
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(clicks[0]!.download).toBe('beer-game-g1.json');
    expect(await screen.findByTestId('export-done')).toBeInTheDocument();
  });
});
