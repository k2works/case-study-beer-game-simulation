import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function issueCredential(): { raw: string; digest: string } {
  const raw = randomBytes(16).toString('base64url');
  return { raw, digest: digestCredential(raw) };
}

export function digestCredential(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function credentialMatches(raw: string, digest: string): boolean {
  const actual = Buffer.from(digestCredential(raw));
  const expected = Buffer.from(digest);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
