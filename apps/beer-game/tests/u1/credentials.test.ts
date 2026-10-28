import { describe, expect, it } from 'vitest';
import {
  credentialMatches,
  digestCredential,
  issueCredential,
} from '../../src/security/credentials.js';

describe('Given recovery credentials', () => {
  it('issues at least 128 bits of entropy', () =>
    expect(Buffer.from(issueCredential().raw, 'base64url')).toHaveLength(16));
  it('stores only a non-reversible digest', () => {
    const value = issueCredential();
    expect(value.digest).not.toContain(value.raw);
    expect(credentialMatches(value.raw, value.digest)).toBe(true);
  });
  it('rejects another credential', () => {
    const value = issueCredential();
    expect(credentialMatches(issueCredential().raw, value.digest)).toBe(false);
  });
  it('is deterministic for the same input', () =>
    expect(digestCredential('token')).toBe(digestCredential('token')));
});
