import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * X-1 / NF-U2: 設計トークン（styles.css の :root）の、コントラスト比の測定（WCAG 2.2 の相対輝度の式）。
 * axe の代わりではない。トークンの組だけを測る（実際の描画の背景・重なり・画像は測らない）。
 * 本文・小さな文字は 4.5:1、大きな文字と、部品の境界・フォーカス表示（非テキスト）は 3:1。
 */
const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

function tokens(): Record<string, string> {
    const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const entries: Array<[string, string]> = [];
    for (const match of root.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
        const [, name, value] = match;
        if (name !== undefined && value !== undefined) entries.push([name, value]);
    }
    return Object.fromEntries(entries);
}

function channel(value: number): number {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function channelAt(hex: string, start: number): number {
    return channel(Number.parseInt(hex.slice(start, start + 2), 16));
}

function luminance(hex: string): number {
    return 0.2126 * channelAt(hex, 1) + 0.7152 * channelAt(hex, 3) + 0.0722 * channelAt(hex, 5);
}

function contrast(foreground: string, background: string): number {
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** トークンの値（無ければ、テストを失敗させる）。 */
function tokenValue(all: Record<string, string>, name: string): string {
    const value = all[name];
    if (value === undefined) throw new Error(`トークン --${name} が styles.css に無い`);
    return value;
}

const TEXT_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
    ['本文', 'fg', 'bg'],
    ['補助の文字（muted）', 'muted', 'bg'],
    ['リンク・ボタンの文字（accent）', 'accent', 'bg'],
    ['エラーの文字', 'error-fg', 'error-bg'],
    ['エラーの文字（通常の背景）', 'error-fg', 'bg'],
];

const NON_TEXT_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
    ['入力欄・通知の枠線（border）', 'border', 'bg'],
    ['フォーカス表示・ボタンの枠線（accent）', 'accent', 'bg'],
    ['エラーの枠線', 'error-fg', 'bg'],
    ['ダイアログの枠線', 'fg', 'bg'],
];

describe('設計トークンのコントラスト比（X-1、NF-U2）', () => {
    const t = tokens();

    it('トークンを読めている', () => {
        expect(Object.keys(t).sort()).toEqual([
            'accent',
            'bg',
            'border',
            'error-bg',
            'error-fg',
            'fg',
            'muted',
        ]);
    });

    it('白と黒は 21:1（式の確認）', () => {
        expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    });

    it.each(TEXT_PAIRS)('%s は 4.5:1 以上', (_label, foreground, background) => {
        expect(
            contrast(tokenValue(t, foreground), tokenValue(t, background)),
        ).toBeGreaterThanOrEqual(4.5);
    });

    it.each(NON_TEXT_PAIRS)('%s は 3:1 以上', (_label, foreground, background) => {
        expect(
            contrast(tokenValue(t, foreground), tokenValue(t, background)),
        ).toBeGreaterThanOrEqual(3);
    });
});
