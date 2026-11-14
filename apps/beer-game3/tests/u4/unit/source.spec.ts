import { describe, expect, it } from 'vitest';
import { normalizeSource } from '../../../src/server/access/source.js';

describe('BR18.3 接続元の正規化（NFR6.6）', () => {
  it('IPv4 は完全なアドレスのまま使う', () => {
    expect(normalizeSource('203.0.113.7')).toBe('203.0.113.7');
  });

  it('ポートが付いていれば除く', () => {
    expect(normalizeSource('203.0.113.7:5555')).toBe('203.0.113.7');
    expect(normalizeSource('[2001:db8:1:2::9]:8080')).toBe(normalizeSource('2001:db8:1:2::1'));
  });

  it('IPv4 射影アドレスは IPv4 に直す', () => {
    expect(normalizeSource('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeSource('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('IPv6 は上位 64 ビット（/64）に丸める。同じ /64 の別アドレスは同じ接続元になる', () => {
    const a = normalizeSource('2001:db8:aaaa:bbbb::1');
    const b = normalizeSource('2001:db8:aaaa:bbbb:1:2:3:4');
    const c = normalizeSource('2001:0DB8:AAAA:BBBB:ffff:ffff:ffff:ffff');
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(normalizeSource('2001:db8:aaaa:bbbc::1')).not.toBe(a);
  });

  it('省略表記（::）を含む IPv6 も同じ /64 に丸める', () => {
    expect(normalizeSource('2001:db8::5')).toBe(normalizeSource('2001:db8:0:0:9:9:9:9'));
    expect(normalizeSource('::1')).toBe(normalizeSource('0:0:0:0:0:0:0:2'));
  });

  it('読めない値は、そのまま（空白を除いて）使う。空なら unknown', () => {
    expect(normalizeSource(' not-an-ip ')).toBe('not-an-ip');
    expect(normalizeSource('')).toBe('unknown');
  });
});
