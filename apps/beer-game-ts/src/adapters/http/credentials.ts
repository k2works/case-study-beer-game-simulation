import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CredentialPolicy } from '../../ports/index.js';

/** 資格のダイジェスト用の鍵。版は保存形式の接頭辞になる */
export interface CredentialKey {
  version: string;
  key: Buffer;
}

/**
 * 資格: 256 ビットの乱数。保存するのは「鍵の版 + 鍵つき HMAC のダイジェスト」だけで、生の資格は保存しない。
 * 保存形式: `<鍵の版>:<hex>`。鍵は複数の版を同時に持ち、発行は最新（最後）の版で行う。
 * 検証は、持っているすべての版のダイジェストで引く（ローテーション後も、旧版の資格を期限まで検証できる）。
 */
export class HmacCredentialPolicy implements CredentialPolicy {
  private readonly current: CredentialKey;

  constructor(private readonly keys: readonly CredentialKey[]) {
    const current = keys.at(-1);
    if (!current) throw new Error('資格の鍵が 1 つもありません');
    this.current = current;
  }

  issue() {
    const token = randomBytes(32).toString('base64url');
    return { token, digest: this.digestWith(this.current, token) };
  }

  /** 最新の版を先頭に、すべての版のダイジェストを返す */
  digestsOf(token: string): string[] {
    return [this.current, ...this.keys.filter((k) => k !== this.current)].map(
      (k) => this.digestWith(k, token),
    );
  }

  /** 定数時間の比較 */
  matches(token: string, digest: string): boolean {
    const b = Buffer.from(digest);
    return this.digestsOf(token).some((d) => {
      const a = Buffer.from(d);
      return a.length === b.length && timingSafeEqual(a, b);
    });
  }

  private digestWith(k: CredentialKey, token: string): string {
    const hex = createHmac('sha256', k.key).update(token).digest('hex');
    return `${k.version}:${hex}`;
  }
}
