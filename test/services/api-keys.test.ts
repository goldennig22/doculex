import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { API_KEY_FORMAT, generateApiKey, hashApiKey, hasRole } from '../../src/services/api-keys.service';
import type { Role } from '../../src/interfaces/types';

describe('generateApiKey', () => {
  it('makes a dlx_ key that requireRole accepts as well formed', () => {
    const { plaintext } = generateApiKey();
    expect(plaintext).toMatch(API_KEY_FORMAT);
  });

  it('never makes the same key twice', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey().plaintext));
    expect(keys.size).toBe(50);
  });

  it('stores only a SHA-256 of the key, and a prefix too short to use', () => {
    const { plaintext, prefix, hash } = generateApiKey();
    expect(hash).toBe(createHash('sha256').update(plaintext).digest('hex'));
    expect(hash).not.toContain(plaintext.slice(4));
    expect(prefix).toBe(plaintext.slice(0, 8));
  });
});

describe('hashApiKey', () => {
  it('is deterministic, so a key can be found through the unique index', () => {
    expect(hashApiKey('dlx_same')).toBe(hashApiKey('dlx_same'));
    expect(hashApiKey('dlx_same')).not.toBe(hashApiKey('dlx_other'));
  });
});

describe('hasRole', () => {
  const cases: [Role, Role, boolean][] = [
    ['admin', 'admin', true], ['admin', 'reviewer', true], ['admin', 'contributor', true],
    ['reviewer', 'admin', false], ['reviewer', 'reviewer', true], ['reviewer', 'contributor', true],
    ['contributor', 'admin', false], ['contributor', 'reviewer', false], ['contributor', 'contributor', true],
  ];
  it.each(cases)('%s may act as %s: %s', (have, need, expected) => {
    expect(hasRole(have, need)).toBe(expected);
  });
});
