import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CredentialPolicy } from '../../ports/index.js';

/**
 * 資格: 256 ビットの乱数。保存するのは「鍵の版 + 鍵つき HMAC のダイジェスト」だけで、生の資格は保存しない。
 * 保存形式: `<鍵の版>:<hex>`
 */
export class HmacCredentialPolicy implements CredentialPolicy {
  constructor(
    private readonly key: Buffer,
    private readonly keyVersion: string,
  ) {}

  issue() {
    const token = randomBytes(32).toString('base64url');
    return { token, digest: this.digestOf(token) };
  }

  digestOf(token: string): string {
    const hex = createHmac('sha256', this.key).update(token).digest('hex');
    return `${this.keyVersion}:${hex}`;
  }

  /** 定数時間の比較 */
  matches(token: string, digest: string): boolean {
    const a = Buffer.from(this.digestOf(token));
    const b = Buffer.from(digest);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
