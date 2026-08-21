import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CredentialStore, secretKey, FORBIDDEN_SETTING_KEYS } from '../src/connections/secrets';

/** An in-memory stand-in for vscode.SecretStorage. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    api: {
      async get(k: string) { return map.get(k); },
      async store(k: string, v: string) { map.set(k, v); },
      async delete(k: string) { map.delete(k); },
    },
  };
}

describe('secret keys', () => {
  it('are namespaced per extension and per profile', () => {
    expect(secretKey('prod', 'password')).toBe('auspexlens:prod:password');
  });

  it('refuse a profile id that could forge another profile key', () => {
    expect(() => secretKey('a:password', 'password')).toThrow(/invalid connection profile id/);
    expect(() => secretKey('has space', 'password')).toThrow();
    expect(() => secretKey('', 'password')).toThrow();
  });
});

describe('CredentialStore', () => {
  it('stores and reads back', async () => {
    const s = fakeStorage();
    const store = new CredentialStore(s.api);
    await store.put('prod', 'password', 'hunter2');
    expect(await store.get('prod', 'password')).toBe('hunter2');
  });

  it('can answer "is it there?" without returning the value', async () => {
    const s = fakeStorage();
    const store = new CredentialStore(s.api);
    await store.put('prod', 'walletPassword', 'wp');
    expect(await store.has('prod', 'walletPassword')).toBe(true);
    expect(await store.has('prod', 'password')).toBe(false);
  });

  it('forgets every secret belonging to a profile', async () => {
    const s = fakeStorage();
    const store = new CredentialStore(s.api);
    await store.put('prod', 'password', 'a');
    await store.put('prod', 'walletPassword', 'b');
    await store.put('prod', 'walletContent', 'c');
    await store.put('other', 'password', 'keep me');
    await store.forget('prod');
    expect([...s.map.keys()]).toEqual(['auspexlens:other:password']);
  });
});

describe('what must never reach settings.json', () => {
  it('names the keys explicitly, so the list is not something a reviewer must remember', () => {
    expect(FORBIDDEN_SETTING_KEYS).toContain('auspexlens.connections.password');
    expect(FORBIDDEN_SETTING_KEYS).toContain('auspexlens.connections.walletContent');
  });

  it('the contributed configuration declares none of them', () => {
    // Read from disk rather than imported: a JSON import needs resolveJsonModule
    // and behaves differently under CJS, and this test should not be the reason
    // a compiler flag changes for the whole package.
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { contributes?: { configuration?: { properties?: Record<string, unknown> } } };
    const declared = Object.keys(pkg.contributes?.configuration?.properties ?? {});
    for (const forbidden of FORBIDDEN_SETTING_KEYS) {
      expect(declared, `${forbidden} is a contributed setting — secrets belong in SecretStorage`)
        .not.toContain(forbidden);
    }
  });
});
