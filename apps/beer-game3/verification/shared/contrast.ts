/**
 * 色の値からコントラスト比を計算する純粋な関数（WCAG 2.x の相対輝度。NFR8.3）。
 * axe-core が測れない文字以外の要素（グラフの線と印）の比を、ブラウザなしで確かめる。
 */

function parseHex(color: string): [number, number, number] {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) {
    throw new Error(`色を #rgb または #rrggbb で指定してください: ${color}`);
  }
  const hex = match[1] ?? '';
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: string): number {
  const [r, g, b] = parseHex(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [light, dark] = a >= b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}
