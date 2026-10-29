import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const credentialKey = () => process.env.CREDENTIAL_HMAC_KEY ?? 'local-development-only-key';

export function issueCredential(): { raw: string; digest: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, digest: digestCredential(raw) };
}

export function digestCredential(raw: string): string {
  return createHmac('sha256', credentialKey()).update(raw, 'utf8').digest('hex');
}

export function credentialMatches(raw: string, digest: string): boolean {
  const actual = Buffer.from(digestCredential(raw));
  const expected = Buffer.from(digest);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
