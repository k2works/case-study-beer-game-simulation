import { isIPv4, isIPv6 } from 'node:net';

/** IPv6 のアドレスを 8 つの 16 ビットの値に展開する。読めなければ null。 */
function expandIPv6(address: string): number[] | null {
  let text = address;
  // 末尾の IPv4 表記（例 64:ff9b::1.2.3.4）は 2 つの 16 ビットの値にする
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIPv4(tail)) {
      return null;
    }
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return null;
  }
  const parse = (part: string): number[] | null => {
    if (part === '') {
      return [];
    }
    const groups = part.split(':').map((group) => Number.parseInt(group, 16));
    return groups.some((group) => Number.isNaN(group)) ? null : groups;
  };
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || rest === null) {
    return null;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const fill = 8 - head.length - rest.length;
  return fill < 0 ? null : [...head, ...Array<number>(fill).fill(0), ...rest];
}

/**
 * 接続元の正規化（BR18.3、NFR6.6）。窓の鍵の元になる。
 * - ポートとゾーンの識別子を除く
 * - IPv4 射影アドレス（::ffff:a.b.c.d）は IPv4 に直す
 * - IPv4 は完全なアドレス、IPv6 は上位 64 ビット（/64）に丸める（同じ /64 のアドレスの回転で窓を回避させない）
 * - 読めない値は、空白を除いてそのまま使う。空なら unknown
 */
export function normalizeSource(address: string): string {
  let value = address.trim();
  if (value === '') {
    return 'unknown';
  }
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) {
    value = bracketed[1] ?? value;
  }
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(value);
  if (withPort) {
    value = withPort[1] ?? value;
  }
  value = value.split('%')[0] ?? value;
  const lower = value.toLowerCase();

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped && isIPv4(mapped[1] ?? '')) {
    return mapped[1] ?? lower;
  }
  if (isIPv4(lower)) {
    return lower;
  }
  if (isIPv6(lower)) {
    const groups = expandIPv6(lower);
    if (groups) {
      return `${groups
        .slice(0, 4)
        .map((group) => group.toString(16))
        .join(':')}::/64`;
    }
  }
  return value;
}
